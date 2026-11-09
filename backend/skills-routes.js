'use strict';

const express = require('express');
const { MAX_BOT_SKILLS, MAX_SKILL_CHARS } = require('./skills-library');

// Reading the library is open to any signed-in caller. Changing it needs a
// person: a skill's text goes into the prompt of every bot that carries it.
function createSkillsRouter({ library, requireAuth, requireInteractiveAuth, listBots, listAllBots, onSkillChanged = () => {} }) {
  const router = express.Router();
  const carriers = (req, id) => listBots(req).filter((bot) => Array.isArray(bot.skills) && bot.skills.includes(id))
    .map((bot) => ({ id: bot.id, name: bot.name }));
  const handle = (action) => async (req, res) => {
    try { res.status(200).json(await action(req)); } catch (error) {
      if (!error.statusCode) throw error;
      res.status(error.statusCode).json({ error: error.code, message: error.message, ...(error.bots ? { bots: error.bots } : {}) });
    }
  };
  router.get('/', requireAuth, handle((req) => ({
    skills: library.list().map(({ body, ...skill }) => ({ ...skill, bots: carriers(req, skill.id) })),
    limits: { perBot: MAX_BOT_SKILLS, skillChars: MAX_SKILL_CHARS },
  })));
  router.get('/:id', requireAuth, handle((req) => {
    const skill = library.read(req.params.id);
    if (!skill) throw Object.assign(new Error('That skill is no longer in the library.'), { statusCode: 404, code: 'skill_not_found' });
    // The editor shows every file in the skill's folder, with its text.
    return { skill: { ...library.withFileText(skill), bots: carriers(req, skill.id) } };
  }));
  router.post('/', requireAuth, requireInteractiveAuth, handle((req) => ({ skill: library.create(req.body || {}) })));
  router.put('/:id', requireAuth, requireInteractiveAuth, handle(async (req) => {
    const skill = library.update(req.params.id, req.body || {});
    await onSkillChanged(skill.id);
    return { skill };
  }));
  router.delete('/:id', requireAuth, requireInteractiveAuth, handle((req) => {
    // Every workspace counts here: the library is shared across them, even
    // though each one only lists its own bots.
    const bots = listAllBots().filter((bot) => Array.isArray(bot.skills) && bot.skills.includes(req.params.id))
      .map((bot) => ({ id: bot.id, name: bot.name }));
    if (bots.length) {
      throw Object.assign(new Error('Take this skill off its bots first.'), { statusCode: 409, code: 'skill_in_use', bots });
    }
    library.remove(req.params.id);
    return { removed: req.params.id };
  }));
  return router;
}

module.exports = { createSkillsRouter };
