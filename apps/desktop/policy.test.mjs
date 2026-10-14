import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backendEnvironment, sameOrigin, workerPopupAllowed } from './policy.mjs'
const origin = 'http://127.0.0.1:43210'
const nonce = 'a'.repeat(64)
const popup = `https://114.132.201.209/admin/#${new URLSearchParams({publish:'1',origin,nonce})}`
test('Worker popup keeps the exact loopback opener and publication nonce', () => {
  assert.equal(workerPopupAllowed(popup, origin), true)
  for (const value of [popup.replace('https:', 'http:'),popup.replace('/admin/', '/'),popup.replace('publish=1','publish=0'),popup.replace(nonce,'bad'),popup.replace('127.0.0.1','evil.test'),popup.replace('https://','https://user:pass@')]) assert.equal(workerPopupAllowed(value, origin), false)
  assert.equal(workerPopupAllowed(popup.replace('https://114.132.201.209','http://127.0.0.1:39999'),origin),true)
})
test('backend never inherits provider credentials or source-launch injection', () => {
  const env = backendEnvironment({PATH:'runtime',OPENAI_API_KEY:'private',DEEPSEEK_API_KEY:'private',DSH_HOME:'old',NODE_OPTIONS:'--import evil',ELECTRON_RUN_AS_NODE:'1',SOME_TOKEN:'private'},'isolated')
  assert.deepEqual(env,{PATH:'runtime',DSH_HOME:'isolated',DSH_TELEMETRY_DISABLED:'1'})
})
test('navigation cannot leave its owning HTTP origin', () => {
  assert.equal(sameOrigin(origin+'/settings',origin),true)
  for(const url of ['file:///C:/private','https://example.com',origin.replace('43210','43211'),'invalid']) assert.equal(sameOrigin(url,origin),false)
})
