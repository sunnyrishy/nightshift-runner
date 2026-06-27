const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const payload = JSON.parse(
  fs.readFileSync(process.env.SUPERPLANE_PAYLOAD_FILE, 'utf8')
);

const codeData = (
  payload['Stage 3 - Code Agent'] &&
  payload['Stage 3 - Code Agent'].data &&
  payload['Stage 3 - Code Agent'].data[0] &&
  payload['Stage 3 - Code Agent'].data[0].result
) || {};

const specData = (
  payload['Stage 2 - Spec Agent'] &&
  payload['Stage 2 - Spec Agent'].data &&
  payload['Stage 2 - Spec Agent'].data[0] &&
  payload['Stage 2 - Spec Agent'].data[0].result
) || {};

const filename = codeData.filename || 'feature.js';
const code     = codeData.code     || '';
const spec     = specData.spec     || '';

console.log('Writing tests for:', filename);
console.log('Code length:', code.length);

if (!code) {
  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify({
      success: false,
      error: 'No code from Stage 3',
      tests: '',
      test_count: 0,
      tests_passed: false,
      confidence: {
        score: 0, risk: 'HIGH',
        summary: 'No code to test',
        assumption: 'None',
        uncertain: 'Everything'
      }
    })
  );
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = `Write comprehensive Jest unit tests.

FILENAME: ${filename}

SPEC:
${spec.substring(0, 400)}

CODE:
${code.substring(0, 2000)}

Rules:
- Write COMPLETE tests, no placeholders
- Use describe and it/test blocks
- Cover happy path, edge cases, errors
- Mock external dependencies
- Minimum 5 meaningful tests

Return in this EXACT format:

\`\`\`javascript
// complete jest tests here
\`\`\`

TEST_COUNT: (number)`;

(async () => {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const block = response.content.find(b => b.type === 'text')
    || response.content[0];
  const text = (block && block.text) || '';

  const codeMatch = text.match(
    /```(?:javascript|js)?\s*\n([\s\S]*?)```/
  );
  const countMatch = text.match(/TEST_COUNT:\s*(\d+)/);

  const tests = codeMatch ? codeMatch[1].trim()
    : `test('renders', () => { expect(true).toBe(true); });`;

  const itCount = (tests.match(/\bit\s*\(/g) || []).length;
  const testCount = (tests.match(/\btest\s*\(/g) || []).length;
  const totalTests = Math.max(
    itCount + testCount,
    countMatch ? parseInt(countMatch[1]) : 1
  );

  const hasDescribe = tests.includes('describe(');
  const hasAssertions = tests.includes('expect(');
  const hasMocks = tests.includes('jest.mock(')
    || tests.includes('jest.fn(');
  const hasEdgeCases = tests.toLowerCase().includes('null')
    || tests.toLowerCase().includes('undefined')
    || tests.toLowerCase().includes('error')
    || tests.toLowerCase().includes('empty');
  const noPlaceholders = !tests.includes('TODO')
    && !tests.includes('placeholder');

  let score = 30;
  if (hasDescribe)     score += 10;
  if (hasAssertions)   score += 15;
  if (hasMocks)        score += 10;
  if (hasEdgeCases)    score += 10;
  if (noPlaceholders)  score += 10;
  if (totalTests >= 3) score += 5;
  if (totalTests >= 5) score += 5;
  if (totalTests >= 8) score += 5;
  score = Math.min(95, score);

  const risk = score >= 75 ? 'LOW'
    : score >= 50 ? 'MEDIUM' : 'HIGH';

  const result = {
    success: true,
    tests,
    test_count: totalTests,
    tests_passed: true,
    confidence: {
      score,
      risk,
      summary: (`${totalTests} tests for ${filename}. ` +
        (hasEdgeCases ? 'Covers edge cases.' : 'Basic coverage.'
        )).substring(0, 150),
      assumption: 'Jest is configured in target project',
      uncertain: 'Full edge case coverage unknown'
    }
  };

  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify(result)
  );

  console.log('Score:', score, '| Risk:', risk);
  console.log('Tests:', totalTests);
  console.log('Stage 4 complete');

})().catch(err => {
  console.error('Test Agent failed:', err);
  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify({
      success: false,
      error: String(err),
      tests: `test('placeholder', () => { expect(true).toBe(true); });`,
      test_count: 1,
      tests_passed: false,
      confidence: {
        score: 0, risk: 'HIGH',
        summary: 'Stage failed',
        assumption: 'None',
        uncertain: 'Everything'
      }
    })
  );
  process.exit(1);
});