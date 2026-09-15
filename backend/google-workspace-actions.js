'use strict';

// A durable Hermes task never receives Mia's Google credentials. Instead it
// may return one private, structured request for a bounded update to a shared
// Sheet or Google Doc whose link the authenticated owner supplied in this
// conversation. The server validates and applies that request, then removes
// the private block before any text is posted to a conversation.

const googleWorkspace = require('./google-gmail');
const googleAccountConnector = require('./google-account-connector');

const ACTION_OPEN = '<MIA_GOOGLE_ACTION>';
const ACTION_CLOSE = '</MIA_GOOGLE_ACTION>';
const DOCS_ACTION_TYPE = 'docs.documents.batchUpdate';
const MAX_ROWS = 200;
const MAX_COLUMNS = 30;
const MAX_CELLS = 3000;
const MAX_CELL_CHARS = 2000;
const MAX_TOTAL_CHARS = 120000;
const WRITE_INTENT_RE = /\b(?:update|edit|write|modify|change|append|add|insert|delete|remove|clear|fill|populate|overwrite|set|mark|move|sort|organize|put)\b/i;
const WRITE_NEGATION_RE = /\b(?:do not|don't|never|without)\b[\s\S]{0,48}\b(?:update|edit|write|modify|change|append|add|insert|delete|remove|clear|fill|populate|overwrite|set|mark|move|sort|organize|put)\b/i;
const SHEET_TARGET_RE = /\b(?:sheet|spreadsheet|cell|cells|range|row|rows|column|columns|tab|table|calendar|it|this|that|these|those)\b/i;
const DOCS_WRITE_INTENT_RE = /\b(?:update|edit|write|modify|change|append|add|insert|replace|rewrite|revise|correct|format|fill|populate|overwrite|set|mark)\b/i;
const DOCS_TARGET_RE = /\b(?:doc|docs|document|paragraph|section|text|content)\b/i;
const DOCS_PRONOUN_TARGET_RE = /\b(?:it|this|that|these|those)\b/i;

function safeGoogleResourceRefs(refs) {
  const output = [];
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const kind = String(ref && ref.kind || '');
    const id = String(ref && ref.id || '');
    if (!['sheets', 'docs', 'drive'].includes(kind) || !/^[A-Za-z0-9_-]{10,256}$/.test(id)) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ kind, id });
    if (output.length >= 3) break;
  }
  return output;
}

function normalizedWriteKinds(writeKinds) {
  if (writeKinds === undefined) return new Set(['sheets', 'docs']);
  return new Set((Array.isArray(writeKinds) ? writeKinds : [])
    .map((kind) => String(kind || '').trim().toLowerCase())
    .filter((kind) => kind === 'sheets' || kind === 'docs'));
}

function googleWorkspaceActionInstruction(refs, writeKinds) {
  const safeRefs = safeGoogleResourceRefs(refs);
  const allowedKinds = normalizedWriteKinds(writeKinds);
  const sections = [];
  const sheetIds = safeRefs
    .filter((ref) => ref.kind === 'sheets' && allowedKinds.has('sheets'))
    .map((ref) => ref.id);
  if (sheetIds.length) {
    sections.push([
      'CONNECTED GOOGLE SHEETS WRITE ACTION:',
      'When, and only when, the user explicitly asks you to update one of the shared spreadsheets below, include exactly one private action block after your user-facing report.',
      `Allowed spreadsheet IDs: ${sheetIds.join(', ')}`,
      `${ACTION_OPEN}{"type":"sheets.values.update","spreadsheetId":"ALLOWED_ID","range":"Sheet1!A1:G20","values":[["row 1"],["row 2"]]}${ACTION_CLOSE}`,
      'Use a precise A1 range, a two-dimensional values array, and only the exact allowed spreadsheet ID. A blank spacer row may be represented as an empty array. Values are written as literal data, not formulas. Do not mention this private block to the user. Never claim the spreadsheet was updated unless you emit a valid action block; Mia applies it after your run and hides the block from chat.',
    ].join('\n'));
  }

  const documentIds = safeRefs
    .filter((ref) => ref.kind === 'docs' && allowedKinds.has('docs'))
    .map((ref) => ref.id);
  if (documentIds.length) {
    sections.push([
      'CONNECTED GOOGLE DOCS WRITE ACTION:',
      'When, and only when, the user explicitly asks you to edit one of the shared Google Docs below, include exactly one private action block after your user-facing report.',
      `Allowed document IDs: ${documentIds.join(', ')}`,
      'Choose exactly one of these two action shapes; do not emit both blocks.',
      `${ACTION_OPEN}{"type":"${DOCS_ACTION_TYPE}","documentId":"ALLOWED_ID","requests":[{"replaceAllText":{"containsText":{"text":"old text","matchCase":true},"replaceText":"new text"}}]}${ACTION_CLOSE}`,
      `${ACTION_OPEN}{"type":"${DOCS_ACTION_TYPE}","documentId":"ALLOWED_ID","requests":[{"insertText":{"endOfSegmentLocation":{"segmentId":""},"text":"Append this paragraph\\n"}}]}${ACTION_CLOSE}`,
      'Use only replaceAllText with non-empty bounded text or insertText at the end of the document. Do not use deleteContentRange, empty replacements, indexed locations, formatting requests, or any other Docs request. Use only an exact allowed document ID. Do not mention this private block to the user. Never claim the document was edited unless Mia reports an applied-operation result.',
    ].join('\n'));
  }
  return sections.join('\n\n');
}

// A model-emitted action is never authorization by itself. The current
// authenticated turn must contain an explicit write request, and the
// conversation must contain at least one server-recognized writable reference.
// Keeping this predicate conservative means an ambiguous request remains
// read-only instead of allowing a background model to mutate a Google resource.
function explicitSheetWriteRequested(message, refs) {
  const hasSheetRef = safeGoogleResourceRefs(refs).some((ref) => ref.kind === 'sheets');
  const text = String(message || '').trim();
  if (!hasSheetRef || !text || WRITE_NEGATION_RE.test(text)) return false;
  return WRITE_INTENT_RE.test(text) && SHEET_TARGET_RE.test(text);
}

function explicitDocsWriteRequested(message, refs) {
  const safeRefs = safeGoogleResourceRefs(refs);
  const hasDocumentRef = safeRefs.some((ref) => ref.kind === 'docs');
  const text = String(message || '').trim();
  if (!hasDocumentRef || !text || WRITE_NEGATION_RE.test(text)) return false;
  if (!DOCS_WRITE_INTENT_RE.test(text)) return false;
  // Pronouns are useful only when the linked-resource set is unambiguous. A
  // direct document noun remains required when Sheets or another resource is
  // also linked, so "edit this" cannot silently choose the wrong provider.
  return DOCS_TARGET_RE.test(text)
    || (!safeRefs.some((ref) => ref.kind !== 'docs') && DOCS_PRONOUN_TARGET_RE.test(text));
}

function googleWorkspaceWriteKinds(message, refs) {
  const text = String(message || '');
  const docsRequested = explicitDocsWriteRequested(text, refs);
  const sheetsRequested = explicitSheetWriteRequested(text, refs);
  const directDocumentTarget = DOCS_TARGET_RE.test(text);
  const directSheetTarget = /\b(?:sheet|spreadsheet|cell|cells|range|row|rows|column|columns|tab|table|calendar)\b/i.test(text);
  if (docsRequested && directDocumentTarget && !directSheetTarget) return ['docs'];
  if (sheetsRequested && directSheetTarget && !directDocumentTarget) return ['sheets'];
  return [
    ...(sheetsRequested ? ['sheets'] : []),
    ...(docsRequested ? ['docs'] : []),
  ];
}

function stripActionFragments(text) {
  let clean = String(text || '').replace(/<MIA_GOOGLE_ACTION>[\s\S]*?<\/MIA_GOOGLE_ACTION>/gi, '');
  const unclosed = clean.search(/<MIA_GOOGLE_ACTION>/i);
  if (unclosed !== -1) clean = clean.slice(0, unclosed);
  return clean.replace(/<\/?MIA_GOOGLE_ACTION>/gi, '').trim();
}

function extractGoogleWorkspaceAction(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(/<MIA_GOOGLE_ACTION>([\s\S]*?)<\/MIA_GOOGLE_ACTION>/gi)];
  const cleanText = stripActionFragments(source);
  const residualTags = source
    .replace(/<MIA_GOOGLE_ACTION>[\s\S]*?<\/MIA_GOOGLE_ACTION>/gi, '')
    .match(/<\/?MIA_GOOGLE_ACTION>/gi);
  if (residualTags) return { text: cleanText, action: null, error: 'malformed_action' };
  if (!matches.length) {
    return { text: cleanText, action: null, error: null };
  }
  if (matches.length !== 1) return { text: cleanText, action: null, error: 'multiple_actions' };
  try {
    return { text: cleanText, action: JSON.parse(matches[0][1]), error: null };
  } catch (_) {
    return { text: cleanText, action: null, error: 'invalid_json' };
  }
}

function validA1Range(value) {
  const range = String(value || '').trim();
  if (!range || range.length > 200 || /[\u0000-\u001f\u007f]/.test(range)) return '';
  const bang = range.lastIndexOf('!');
  if (bang < 1) return '';
  const sheet = range.slice(0, bang);
  const cells = range.slice(bang + 1);
  if (sheet.length > 120 || /[\[\]*?\\/:]/.test(sheet)) return '';
  if (!/^[A-Za-z]{1,3}[1-9]\d{0,5}(?::[A-Za-z]{1,3}[1-9]\d{0,5})?$/.test(cells)) return '';
  return `${sheet}!${cells.toUpperCase()}`;
}

function normalizeValues(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_ROWS) return null;
  const normalized = [];
  let cells = 0;
  let chars = 0;
  for (const inputRow of values) {
    if (!Array.isArray(inputRow) || inputRow.length > MAX_COLUMNS) return null;
    // Models commonly represent a visual spacer row as []. Google accepts a
    // ragged 2-D payload, but keeping an empty inner array in the request is
    // ambiguous and used to fail our own validation before Google was called.
    // Normalize it to one explicit blank literal while retaining every size
    // and type bound below.
    if (!inputRow.length) {
      cells += 1;
      if (cells > MAX_CELLS) return null;
      normalized.push(['']);
      continue;
    }
    const row = [];
    for (const value of inputRow) {
      cells += 1;
      if (cells > MAX_CELLS) return null;
      if (value === null) {
        row.push('');
        continue;
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      if (typeof value === 'string') {
        if (value.length > MAX_CELL_CHARS) return null;
        chars += value.length;
        if (chars > MAX_TOTAL_CHARS) return null;
      }
      row.push(value);
    }
    normalized.push(row);
  }
  return normalized;
}

function hasExactActionKeys(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  const keys = Object.keys(action).sort();
  return keys.length === 3 && keys[0] === 'documentId' && keys[1] === 'requests' && keys[2] === 'type';
}

function validateDocsWorkspaceAction(action, refs) {
  if (!hasExactActionKeys(action) || action.type !== DOCS_ACTION_TYPE) return null;
  const documentId = String(action.documentId || '');
  const allowed = new Set(safeGoogleResourceRefs(refs)
    .filter((ref) => ref.kind === 'docs')
    .map((ref) => ref.id));
  if (!allowed.has(documentId)) return null;
  const normalized = googleAccountConnector.normalizeDocsBatchUpdatePayload(
    { documentId },
    { requests: action.requests }
  );
  if (!normalized) return null;
  return { type: DOCS_ACTION_TYPE, documentId, requests: normalized.requests };
}

function validateGoogleWorkspaceAction(action, refs) {
  if (!action) return null;
  if (action.type === DOCS_ACTION_TYPE) return validateDocsWorkspaceAction(action, refs);
  if (action.type !== 'sheets.values.update') return null;
  const spreadsheetId = String(action.spreadsheetId || '');
  const allowed = new Set(safeGoogleResourceRefs(refs)
    .filter((ref) => ref.kind === 'sheets')
    .map((ref) => ref.id));
  if (!allowed.has(spreadsheetId)) return null;
  const range = validA1Range(action.range);
  const values = normalizeValues(action.values);
  if (!range || !values) return null;
  return { type: 'sheets.values.update', spreadsheetId, range, values };
}

function googleWorkspaceActionKind(action) {
  if (!action || typeof action.type !== 'string') return null;
  if (action.type === DOCS_ACTION_TYPE) return 'docs';
  if (action.type === 'sheets.values.update') return 'sheets';
  return null;
}

async function applyGoogleWorkspaceAction({ action, refs, connector, config, connection, fetchImpl = global.fetch }) {
  const validated = validateGoogleWorkspaceAction(action, refs);
  if (!validated) {
    const error = new Error('invalid_google_workspace_action');
    error.code = 'invalid_google_workspace_action';
    throw error;
  }

  // Hermes owns the Google account in production. The connector receives
  // only an allowlisted operation and structured arguments; OAuth tokens and
  // credential files stay inside the Hermes/gws runtime.
  if (connector) {
    let status;
    try {
      status = typeof connector.status === 'function' ? await connector.status() : null;
    } catch (_) {
      status = null;
    }
    if (!status || status.connected !== true || (status.state && status.state !== 'connected')) {
      const error = new Error('google_workspace_reconnect_required');
      error.code = 'google_workspace_reconnect_required';
      throw error;
    }
    if (typeof connector.runOperation !== 'function') {
      const error = new Error('google_connector_unavailable');
      error.code = 'google_connector_unavailable';
      throw error;
    }
    if (validated.type === DOCS_ACTION_TYPE) {
      await connector.runOperation(DOCS_ACTION_TYPE, [
        '--params', JSON.stringify({ documentId: validated.documentId }),
        '--json', JSON.stringify({ requests: validated.requests }),
      ]);
      return {
        documentId: validated.documentId,
        appliedRequests: validated.requests.length,
      };
    }
    const response = await connector.runOperation('sheets.values.update', [
      '--params', JSON.stringify({
        spreadsheetId: validated.spreadsheetId,
        range: validated.range,
        valueInputOption: 'RAW',
      }),
      '--json', JSON.stringify({
        range: validated.range,
        majorDimension: 'ROWS',
        values: validated.values,
      }),
    ]);
    return {
      spreadsheetId: validated.spreadsheetId,
      range: validated.range,
      updatedCells: Number(response && (response.updatedCells || (response.updates && response.updates.updatedCells)))
        || validated.values.reduce((sum, row) => sum + row.length, 0),
    };
  }

  if (!googleWorkspace.isConfigured(config) || !connection || !googleWorkspace.hasRequiredScopes(connection.grantedScopes)) {
    const error = new Error('google_workspace_reconnect_required');
    error.code = 'google_workspace_reconnect_required';
    throw error;
  }

  if (validated.type === DOCS_ACTION_TYPE) {
    // The production path is the Hermes-owned gws connector. Keep the legacy
    // OAuth compatibility path Sheets-only rather than adding a second Docs
    // write implementation with different authorization semantics.
    const error = new Error('google_connector_unavailable');
    error.code = 'google_connector_unavailable';
    throw error;
  }

  let refreshToken = '';
  let accessToken = '';
  try {
    refreshToken = googleWorkspace.decryptRefreshToken(connection.encryptedRefreshToken, config.tokenEncryptionKey);
    accessToken = await googleWorkspace.refreshAccessToken(refreshToken, config, fetchImpl);
    const response = await googleWorkspace.writeSpreadsheetValues(
      accessToken,
      validated.spreadsheetId,
      validated.range,
      validated.values,
      fetchImpl
    );
    return {
      spreadsheetId: validated.spreadsheetId,
      range: validated.range,
      updatedCells: Number(response && response.updatedCells) || validated.values.reduce((sum, row) => sum + row.length, 0),
    };
  } finally {
    refreshToken = '';
    accessToken = '';
  }
}

module.exports = {
  ACTION_OPEN,
  ACTION_CLOSE,
  DOCS_ACTION_TYPE,
  MAX_ROWS,
  MAX_COLUMNS,
  MAX_CELLS,
  MAX_DOC_BATCH_REQUESTS: googleAccountConnector.MAX_DOC_BATCH_REQUESTS,
  MAX_DOC_TEXT_CHARS: googleAccountConnector.MAX_DOC_TEXT_CHARS,
  MAX_DOC_TOTAL_CHARS: googleAccountConnector.MAX_DOC_TOTAL_CHARS,
  safeGoogleResourceRefs,
  googleWorkspaceActionInstruction,
  explicitSheetWriteRequested,
  explicitDocsWriteRequested,
  googleWorkspaceWriteKinds,
  extractGoogleWorkspaceAction,
  validateGoogleWorkspaceAction,
  googleWorkspaceActionKind,
  applyGoogleWorkspaceAction,
};
