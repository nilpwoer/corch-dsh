import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { readJdPage } from './jd-browser.mjs'

function read(html, url = 'https://www.zhipin.com/web/geek/jobs?_security_check=private') {
  const dom = new JSDOM(html, { url })
  // JSDOM has no layout or innerText; expose rendered fixture text and rectangle visibility.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    for (let element = this; element; element = element.parentElement) if (dom.window.getComputedStyle(element).display === 'none') return []
    return [{}]
  }
  try { return readJdPage(dom.window.document) }
  finally { dom.window.close() }
}

const detail = '<div class="job-detail"><h1>后端开发工程师</h1>\n职位描述\n任职要求：掌握 SQL 与接口开发。</div>'
const link = '<a href="/job_detail/job-1.html?tracking=private#share">后端开发工程师</a>'

test('BOSS list capture identifies the displayed role and its unique detail link', () => {
  const result = read('<title>成都招聘列表</title>' + link + detail)
  assert.equal(result.title, '后端开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
  assert.equal(result.body, '后端开发工程师\n职位描述\n任职要求：掌握 SQL 与接口开发。')
})

test('hidden and incidental detail class matches cannot hide the actual duties', () => {
  const result = read('<div class="job-detail-empty"></div><div class="job-detail-heading">职位描述</div><div class="job-detail" style="display:none">错误岗位\n岗位职责：隐藏内容</div>' + link + detail)
  assert.equal(result.title, '后端开发工程师')
  assert.ok(result.body.includes('掌握 SQL 与接口开发'))
  assert.ok(!result.body.includes('隐藏内容'))
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('a direct detail page reads the duties section after an incidental header', () => {
  const result = read('<title>招聘站点</title><div class="job-detail-header"><h1>.net开发工程师</h1>成都</div><div class="job-detail-label">职位描述</div><div class="job-sec-text">任职要求：开发 .NET 后端接口。</div>', 'https://www.zhipin.com/job_detail/job-2.html?_security_check=private#share')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.body, '任职要求：开发 .NET 后端接口。')
})

test('BOSS standalone title and duties exclude sharing controls and recommendations', () => {
  const html = '<title>列表式页面标题</title><h1>.net开发工程师</h1><div class="job-detail">微信扫码分享 举报\n<div class="job-description">职位描述\n<div class="job-sec-text">岗位职责：开发 C# 接口。\n任职要求：熟悉 ASP.NET 和 SQL。</div></div><aside>推荐职位\n其他公司工程师</aside></div>'
  const result = read(html, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.body, '职位描述\n岗位职责：开发 C# 接口。\n任职要求：熟悉 ASP.NET 和 SQL。')
  assert.ok(!result.body.includes('微信扫码分享'))
  assert.ok(!result.body.includes('推荐职位'))
})

test('separate visible duties and requirements sections remain together in original order', () => {
  const result = read('<h1>.net开发工程师</h1><div class="job-detail">分享\n<div class="job-sec-text">岗位职责：开发接口。</div><div class="job-sec-text">任职要求：掌握 SQL。</div><aside>推荐职位</aside></div>', 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.body, '岗位职责：开发接口。\n\n任职要求：掌握 SQL。')
})

test('a visible description outside the selected detail cannot merge another job into its original', () => {
  const unrelated = '<aside class="job-description">岗位职责：其他企业销售产品。任职要求：销售经验。</aside>'
  const result = read(unrelated + '<h1>.net开发工程师</h1><div class="job-detail"><div class="job-sec-text">岗位职责：开发接口。</div><div class="job-sec-text">任职要求：掌握 SQL。</div></div>' + unrelated, 'https://www.zhipin.com/job_detail/job-2.html')
  assert.equal(result.title, '.net开发工程师')
  assert.equal(result.body, '岗位职责：开发接口。\n\n任职要求：掌握 SQL。')
  assert.ok(!result.body.includes('其他企业'))
})

test('missing, unrelated, cross-origin and ambiguous detail links cannot become list sources', () => {
  for (const links of ['', '<a href="/job_detail/job-1.html">其他岗位</a>', '<a href="https://other.test/job_detail/job-1.html">后端开发工程师</a>', '<a href="https://user:password@www.zhipin.com/job_detail/job-1.html">后端开发工程师</a>', '<a href="http://[invalid">后端开发工程师</a>', link + '<a href="/job_detail/job-2.html">后端开发工程师</a>']) {
    assert.equal(read(links + detail).url, null)
  }
  assert.equal(read(link + link + detail).url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('body-first titles in list detail panes match their exact source anchors', () => {
  const result = read(link + '<div class="job-detail">后端开发工程师\n成都\n职位描述\n岗位职责：开发接口。</div>')
  assert.equal(result.title, '后端开发工程师')
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/job-1.html')
})

test('ordinary pages preserve the original source and visible login fields', () => {
  const result = read('<main><h1>合成后端开发岗位</h1><p>岗位职责：开发接口。</p><input type="password"><input autocomplete="one-time-code" style="display:none"></main>', 'http://127.0.0.1:4321/job?detail=1')
  assert.equal(result.url, 'http://127.0.0.1:4321/job?detail=1')
  assert.equal(result.title, '合成后端开发岗位')
  assert.equal(result.login, true)
})
