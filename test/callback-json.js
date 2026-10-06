'use strict'

// Test double for the callback contract expected by puny-req.
// This deliberately makes no claim about the installed JSON dependency.
module.exports = {
  stringify: JSON.stringify,
  parse: function (value, callback) {
    let parsed
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      callback(error)
      return
    }
    callback(null, parsed)
  }
}
