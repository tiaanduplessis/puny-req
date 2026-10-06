'use strict'

const url = require('url')
const assert = require('assert')

const http = require('follow-redirects').http
const https = require('follow-redirects').https
const qs = require('qs')
const JSON = require('@tiaanduplessis/json')

const isString = function isString (val = '') {
  return typeof val === 'string'
}

const req = function req (args) {
  const promise = new Promise((resolve, reject) => {
    assert(isString(args) || args.url, 'Missing URL')

    if (isString(args)) {
      args = { url: args }
    }

    const parsedUrl = url.parse(args.url)
    const protocol = parsedUrl.protocol === 'http:' ? http : https
    const options = Object.assign(
      {
        hostname: parsedUrl.hostname,
        port: Number(parsedUrl.port || (parsedUrl.protocol === 'http:' ? '80' : '443')),
        method: args.form || args.json ? 'POST' : 'GET',
        headers: {},
        path: parsedUrl.path,
        auth: parsedUrl.auth || null,
        encoding: 'utf-8'
      },
      args
    )

    if (options.form) {
      options.data = isString(options.form) ? options.form : qs.stringify(options.form)
      options.headers = Object.assign(options.headers, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(options.data)
      })
    }

    if (options.json) {
      options.data = JSON.stringify(options.json)
      options.headers = Object.assign(options.headers, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(options.data)
      })
    }

    const req = protocol.request(options, res => {
      res.setEncoding(options.encoding)

      res.body = ''
      res.on('data', chunk => {
        res.body += chunk
      })
      res.on('end', () => {
        JSON.parse(res.body, (error, json) => {
          if (!error) {
            res.body = json
          }

          resolve(res)
        })
      })
    })

    req.on('error', error => reject(error))
    req.on('timeout', () => {
      req.abort()
      reject(new Error('Request timed out'))
    })

    options.data && req.write(options.data)

    req.end()
  })

  return promise
}

module.exports = req
