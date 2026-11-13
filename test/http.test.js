import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWriteRequest, isLoopback } from '../src/http.js'

/** @param {Record<string, string>} headers @param {string} remoteAddress */
function request(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('only loopback requests reach the API', () => {
  assert.equal(isLoopback(request()), true)
  assert.equal(isLoopback(request({}, '::1')), true)
  assert.equal(isLoopback(request({}, '::ffff:127.0.0.1')), true)
  assert.equal(isLoopback(request({}, '10.0.0.7')), false)
  const denied = checkWriteRequest(request({}, '10.0.0.7'), 'http://127.0.0.1:1', 'secret')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'LOOPBACK_ONLY')
})

test('an empty configured token disables writes entirely', () => {
  const result = checkWriteRequest(request(), 'http://127.0.0.1:1', '')
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.equal(result.code, 'WRITE_DISABLED')
})

test('a cross-origin write is rejected even with the right token', () => {
  const result = checkWriteRequest(
    request({ origin: 'https://evil.example', 'x-overwatch-token': 'secret' }),
    'http://127.0.0.1:1',
    'secret',
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CROSS_ORIGIN')
})

test('the token is compared exactly', () => {
  assert.equal(checkWriteRequest(request({ 'x-overwatch-token': 'wrong' }), 'http://127.0.0.1:1', 'secret').code, 'UNAUTHORIZED')
  assert.equal(checkWriteRequest(request({ 'x-overwatch-token': 'secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
  assert.equal(checkWriteRequest(request({ authorization: 'Bearer secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
  assert.equal(checkWriteRequest(request({ origin: 'http://127.0.0.1:1', 'x-overwatch-token': 'secret' }), 'http://127.0.0.1:1', 'secret').ok, true)
})
