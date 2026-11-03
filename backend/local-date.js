'use strict';

// The calendar date on this machine's clock, as YYYY-MM-DD. toISOString() gives
// the UTC date, which is already tomorrow during the evening west of UTC.
function localDateString(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The same clock with the time added, as YYYY-MM-DDThh:mm:ss and no offset.
function localDateTimeString(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${localDateString(date)}T${hours}:${minutes}:${seconds}`;
}

module.exports = { localDateString, localDateTimeString };
