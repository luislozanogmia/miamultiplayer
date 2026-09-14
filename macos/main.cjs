"use strict";

// The package manifest and release build use src/main.cjs. Keep this manual
// entrypoint pointed at the same implementation so it cannot drift into a
// second shell with different security or path rules.
module.exports = require("./src/main.cjs");
