/* eslint-env jest */
'use strict'

// Isolate routing from the separate callback/promise mismatch in the locked
// @tiaanduplessis/json dependency. follow-redirects and qs remain real modules.
jest.mock('@tiaanduplessis/json', () => require('./test/callback-json'), { virtual: true })

const cases = require('./test/ports')

Object.keys(cases).forEach(name => test(name, cases[name]))
