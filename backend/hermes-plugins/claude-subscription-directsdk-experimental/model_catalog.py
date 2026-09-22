"""Pinned native routes with Mia's bounded advertised context policy."""
CONTEXT_WINDOWS = {
    'claude-sonnet-5': 250_000,
    'claude-haiku-4-5-20251001': 200_000,
    'claude-opus-5': 250_000,
    'claude-opus-4-8': 250_000,
    'claude-fable-5-1': 250_000,
}
LONG_CONTEXT_ROUTES = frozenset(model for model in CONTEXT_WINDOWS if 'haiku' not in model)
ALIASES = {
    'sonnet': 'claude-sonnet-5',
    'haiku': 'claude-haiku-4-5-20251001',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'opus': 'claude-opus-5',
    'fable': 'claude-fable-5-1',
}


def native_model(model):
    base = model.removesuffix('[1m]')
    canonical = ALIASES.get(base, base)
    window = CONTEXT_WINDOWS.get(canonical)
    # Claude Code's real explicit long-context selector remains `[1m]`. The
    # lower number above is Mia's advertised budgeting cap, not an SDK route.
    if canonical in LONG_CONTEXT_ROUTES:
        return canonical + '[1m]'
    if window == 200_000:
        if model.endswith('[1m]'):
            raise ValueError('Haiku 4.5 does not support a 1M context window')
        return canonical
    return model


MODEL_METADATA = {
    native_model(model): {'canonical_model': model, 'context_window': window}
    for model, window in CONTEXT_WINDOWS.items()
}
