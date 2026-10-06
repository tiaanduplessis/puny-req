'use strict'

const assert = require('assert')
const EventEmitter = require('events')
const http = require('http')
const https = require('https')
const request = require('../')

// Exercise the installed follow-redirects implementation without opening sockets.
// Every native request is recorded and must consume a configured response.
function withTransport (responses, run) {
  const originals = { http: http.request, https: https.request }
  const calls = []
  let failTransport
  const transportFailure = new Promise((resolve, reject) => { failTransport = reject })

  function transport (protocol) {
    return function (options, callback) {
      assert(responses.length > 0, 'Unexpected native request')
      const response = responses.shift()
      const req = new EventEmitter()
      const call = {
        protocol,
        options: Object.assign({}, options, { headers: Object.assign({}, options.headers) }),
        body: '',
        request: req
      }
      calls.push(call)
      req.write = function (data, encoding, done) {
        call.body += Buffer.isBuffer(data) ? data.toString() : data
        if (typeof encoding === 'function') done = encoding
        if (done) done()
        return true
      }
      req.abort = function () {
        call.aborted = true
        req.emit('abort')
      }
      req.end = function (data) {
        if (data) req.write(data)
        process.nextTick(() => {
          try {
            if (response.error) return req.emit('error', response.error)
            if (response.timeout) return req._redirectable.emit('timeout')
            const res = new EventEmitter()
            res.statusCode = response.statusCode || 200
            res.headers = response.headers || {}
            res.setEncoding = function (encoding) { call.encoding = encoding }
            callback(res)
            res.emit('data', response.body || 'Responded')
            res.emit('end')
          } catch (error) {
            failTransport(error)
          }
        })
      }
      return req
    }
  }

  http.request = transport('http:')
  https.request = transport('https:')

  function restore () {
    http.request = originals.http
    https.request = originals.https
  }

  return Promise.race([Promise.resolve().then(() => run(calls)), transportFailure]).then(() => {
    restore()
    assert.strictEqual(responses.length, 0, 'Unconsumed native responses')
  }, error => {
    restore()
    throw error
  })
}

const cases = {}

;[
  ['http:', '', 80],
  ['https:', '', 443],
  ['http:', ':80', 80],
  ['https:', ':443', 443],
  ['http:', ':8123', 8123],
  ['https:', ':8443', 8443],
  ['http:', ':443', 443],
  ['https:', ':80', 80],
  ['http:', ':0', 0],
  ['https:', ':0', 0],
  ['http:', ':65535', 65535],
  ['https:', ':65535', 65535]
].forEach(([protocol, port, expected]) => {
  ;['string', 'object'].forEach(form => {
    cases[`${form} ${protocol}//example.test${port} preserves its port`] = () => {
      const url = `${protocol}//example.test${port}/path?q=1`
      const input = form === 'string' ? url : { url }
      return withTransport([{}], calls => request(input).then(res => {
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].protocol, protocol)
        assert.strictEqual(calls[0].options.port, expected)
        assert.strictEqual(calls[0].options.hostname, 'example.test')
        assert.strictEqual(calls[0].options.path, '/path?q=1')
        assert.strictEqual(calls[0].options.method, 'GET')
        assert.strictEqual(calls[0].encoding, 'utf-8')
        assert.strictEqual(res.body, 'Responded')
      }))
    }
  })
})

;['http:', 'https:'].forEach(protocol => {
  ;[9123, '9124', 0].forEach(port => {
    cases[`${protocol} explicit options.port ${JSON.stringify(port)} takes precedence`] = () => {
      return withTransport([{}], calls => request({ url: `${protocol}//example.test:8123/`, port }).then(() => {
        assert.strictEqual(calls[0].options.port, port)
      }))
    }
  })
})

cases['retains URL credentials, headers, explicit method and response JSON'] = () => {
  return withTransport([{ body: '{"ok":true}' }], calls => request({
    url: 'https://user:pass@example.test:8443/path?query=one#fragment',
    headers: { 'X-Test': 'yes' },
    method: 'PATCH',
    encoding: 'ascii'
  }).then(res => {
    assert.strictEqual(calls[0].options.auth, 'user:pass')
    assert.strictEqual(calls[0].options.path, '/path?query=one')
    assert.strictEqual(calls[0].options.method, 'PATCH')
    assert.strictEqual(calls[0].options.headers['X-Test'], 'yes')
    assert.strictEqual(calls[0].encoding, 'ascii')
    assert.deepStrictEqual(res.body, { ok: true })
  }))
}

;[
  ['form object', { form: { name: 'Tiaan & café' } }, 'name=Tiaan%20%26%20caf%C3%A9', 'application/x-www-form-urlencoded'],
  ['form string', { form: 'name=café' }, 'name=café', 'application/x-www-form-urlencoded'],
  ['JSON object', { json: { name: 'café' } }, '{"name":"café"}', 'application/json']
].forEach(([name, body, expected, contentType]) => {
  cases[`retains ${name} body and byte length`] = () => {
    return withTransport([{}], calls => request(Object.assign({ url: 'http://example.test:8123/' }, body)).then(() => {
      assert.strictEqual(calls[0].options.port, 8123)
      assert.strictEqual(calls[0].options.method, 'POST')
      assert.strictEqual(calls[0].body, expected)
      assert.strictEqual(calls[0].options.headers['Content-Type'], contentType)
      assert.strictEqual(calls[0].options.headers['Content-Length'], Buffer.byteLength(expected))
    }))
  }
})

cases['relative redirects retain the explicit initial URL port'] = () => {
  return withTransport([{ statusCode: 302, headers: { location: '/next' } }, {}], calls => {
    return request('http://example.test:8123/start').then(() => {
      assert.deepStrictEqual(calls.map(call => Number(call.options.port)), [8123, 8123])
      assert.deepStrictEqual(calls.map(call => call.options.path), ['/start', '/next'])
    })
  })
}

cases['cross-protocol redirects use the target URL port'] = () => {
  return withTransport([{ statusCode: 302, headers: { location: 'https://example.test:8443/next' } }, {}], calls => {
    return request('http://example.test:8123/start').then(() => {
      assert.deepStrictEqual(calls.map(call => call.protocol), ['http:', 'https:'])
      assert.deepStrictEqual(calls.map(call => Number(call.options.port)), [8123, 8443])
    })
  })
}

cases['HTTPS to HTTP redirects use the target URL port'] = () => {
  return withTransport([{ statusCode: 302, headers: { location: 'http://example.test:8123/next' } }, {}], calls => {
    return request('https://example.test:8443/start').then(() => {
      assert.deepStrictEqual(calls.map(call => call.protocol), ['https:', 'http:'])
      assert.deepStrictEqual(calls.map(call => Number(call.options.port)), [8443, 8123])
    })
  })
}

cases['absolute redirects without a port do not retain the initial port'] = () => {
  return withTransport([{ statusCode: 302, headers: { location: 'https://example.test/next' } }, {}], calls => {
    return request('http://example.test:8123/start').then(() => {
      assert.strictEqual(calls[0].options.port, 8123)
      assert.strictEqual(calls[1].protocol, 'https:')
      assert.strictEqual(calls[1].options.port, null)
    })
  })
}

cases['followRedirects false returns the original response'] = () => {
  return withTransport([{ statusCode: 302, headers: { location: '/not-followed' } }], calls => {
    return request({ url: 'https://example.test:8443/', followRedirects: false }).then(res => {
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].options.port, 8443)
      assert.strictEqual(res.statusCode, 302)
      assert.strictEqual(res.headers.location, '/not-followed')
    })
  })
}

;[302, 307].forEach(statusCode => {
  cases[`${statusCode} redirects retain the existing method and body policy`] = () => {
    return withTransport([{ statusCode, headers: { location: '/next' } }, {}], calls => {
      return request({ url: 'https://example.test:8443/start', json: { ok: true } }).then(() => {
        assert.strictEqual(calls[0].body, '{"ok":true}')
        assert.strictEqual(calls[1].options.method, statusCode === 307 ? 'POST' : 'GET')
        assert.strictEqual(calls[1].body, statusCode === 307 ? '{"ok":true}' : '')
        assert.strictEqual(calls[1].options.headers['Content-Type'], statusCode === 307 ? 'application/json' : undefined)
      })
    })
  }
})

cases['request errors reject with the original error'] = () => {
  const expected = new Error('controlled request failure')
  return withTransport([{ error: expected }], () => request('https://example.test:8443/').then(() => {
    throw new Error('Expected rejection')
  }, error => assert.strictEqual(error, expected)))
}

cases['redirect-limit errors remain visible'] = () => {
  const redirect = { statusCode: 302, headers: { location: '/again' } }
  return withTransport([redirect, redirect], () => request({ url: 'http://example.test:8123/', maxRedirects: 1 }).then(() => {
    throw new Error('Expected rejection')
  }, error => assert.strictEqual(error.message, 'Max redirects exceeded.')))
}

cases['timeout handling still aborts the active request and rejects'] = () => {
  return withTransport([{ timeout: true }], calls => request('http://example.test:8123/').then(() => {
    throw new Error('Expected rejection')
  }, error => {
    assert.strictEqual(error.message, 'Request timed out')
    assert.strictEqual(calls[0].aborted, true)
  }))
}

cases['missing URL rejects before creating a native request'] = () => {
  return withTransport([], calls => request({}).then(() => {
    throw new Error('Expected rejection')
  }, error => {
    assert.strictEqual(error.message, 'Missing URL')
    assert.strictEqual(calls.length, 0)
  }))
}

cases['unconfigured redirects fail closed and restore both native transports'] = () => {
  const originalHttp = http.request
  const originalHttps = https.request
  return withTransport([{ statusCode: 302, headers: { location: '/unexpected' } }], () => {
    return request('http://example.test:8123/')
  }).then(() => {
    throw new Error('Expected transport failure')
  }, error => {
    assert.strictEqual(error.message, 'Unexpected native request')
    assert.strictEqual(http.request, originalHttp)
    assert.strictEqual(https.request, originalHttps)
  })
}

module.exports = cases
