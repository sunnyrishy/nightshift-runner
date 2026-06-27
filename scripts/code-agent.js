const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const payload = JSON.parse(
  fs.readFileSync(process.env.SUPERPLANE_PAYLOAD_FILE, 'utf8')
);

const intake = (
  payload['Stage 1 - Intake'] &&
  payload['Stage 1 - Intake'].data &&
  payload['Stage 1 - Intake'].data.body &&
  payload['Stage 1 - Intake'].data.body.data
) || {};

const debate = (
  payload['Stage 2.5 - Devils Advocate'] &&
  payload['Stage 2.5 - Devils Advocate'].data &&
  payload['Stage 2.5 - Devils Advocate'].data.body &&
  payload['Stage 2.5 - Devils Advocate'].data.body.data
) || {};

const specRunner = (
  payload['Stage 2 - Spec Agent'] &&
  payload['Stage 2 - Spec Agent'].data &&
  payload['Stage 2 - Spec Agent'].data[0] &&
  payload['Stage 2 - Spec Agent'].data[0].result
) || {};

const title = intake.title || '';
const revisedSpec = debate.revised_spec || specRunner.spec || '';

console.log('Coding for:', title);
console.log('Spec length:', revisedSpec.length);

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = `You are a senior software engineer.
Implement this feature in clean, complete, working JavaScript.

TITLE: ${title}

SPEC:
${revisedSpec}

Rules:
- Write COMPLETE code, no TODOs, no placeholders
- Include all imports at the top
- Handle errors gracefully
- Add clear comments for complex logic

Return in this EXACT format:

FILENAME: ComponentName.js

\`\`\`javascript
// complete working code here
\`\`\`

DEPENDENCIES:
comma separated npm packages if any`;

(async () => {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const block = response.content.find(b => b.type === 'text')
    || response.content[0];
  const text = (block && block.text) || '';

  const filenameMatch = text.match(/FILENAME:\s*(\S+)/);
  const codeMatch = text.match(
    /```(?:javascript|js|tsx|ts)?\s*\n([\s\S]*?)```/
  );
  const depsMatch = text.match(/DEPENDENCIES:\s*(.+)/);

  const filename = filenameMatch
    ? filenameMatch[1].trim() : 'feature.js';
  const code = codeMatch
    ? codeMatch[1].trim() : text;
  const dependencies = depsMatch
    ? depsMatch[1].trim() : '';

  console.log('Filename:', filename);
  console.log('Code length:', code.length);

  const lineCount = code.split('\n').length;
  const hasImports = code.includes('import ')
    || code.includes('require(');
  const hasErrorHandling = code.includes('catch')
    || code.includes('try');
  const hasComments = code.includes('//')
    || code.includes('/*');
  const hasExports = code.includes('export ')
    || code.includes('module.exports');
  const noTodos = !code.includes('TODO')
    && !code.includes('placeholder');

  let score = 35;
  if (lineCount > 20)      score += 15;
  if (lineCount > 50)      score += 10;
  if (lineCount > 100)     score += 10;
  if (hasImports)          score += 5;
  if (hasErrorHandling)    score += 10;
  if (hasComments)         score += 5;
  if (hasExports)          score += 5;
  if (noTodos)             score += 5;
  score = Math.min(95, score);

  const risk = score >= 75 ? 'LOW'
    : score >= 50 ? 'MEDIUM' : 'HIGH';

  const result = {
    success: true,
    filename,
    code,
    dependencies,
    confidence: {
      score,
      risk,
      summary: (`${lineCount} lines in ${filename}. ` +
        (noTodos ? 'Complete.' : 'May be incomplete.'
        )).substring(0, 150),
      assumption: 'Spec has enough detail to implement',
      uncertain: 'Integration with existing codebase unknown'
    }
  };

  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify(result)
  );

  console.log('Score:', score, '| Risk:', risk);
  console.log('Stage 3 complete');

})().catch(err => {
  console.error('Code Agent failed:', err);
  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify({
      success: false,
      error: String(err),
      filename: 'feature.js',
      code: '',
      dependencies: '',
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