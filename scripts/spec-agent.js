const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

console.log('=== ENVIRONMENT ===');
console.log('RESULT FILE:', process.env.SUPERPLANE_RESULT_FILE);
console.log('API KEY SET:', !!process.env.ANTHROPIC_API_KEY);

// Check /mnt/ directory
console.log('=== /mnt/ CONTENTS ===');
try {
  const mntFiles = fs.readdirSync('/mnt');
  console.log('Files in /mnt:', mntFiles.join(', '));
  
  // Read each file in /mnt
  for (const f of mntFiles) {
    try {
      const content = fs.readFileSync(`/mnt/${f}`, 'utf8');
      console.log(`/mnt/${f} preview:`, content.substring(0, 300));
    } catch (e) {
      console.log(`Cannot read /mnt/${f}:`, e.message);
    }
  }
} catch (e) {
  console.log('Cannot read /mnt:', e.message);
}

// Check for payload in common locations
const possiblePayloadPaths = [
  '/mnt/superplane-payload.json',
  '/mnt/payload.json',
  '/mnt/input.json',
  '/tmp/payload.json',
  '/superplane-payload.json'
];

let payloadData = null;
let foundPath = null;

for (const p of possiblePayloadPaths) {
  try {
    const content = fs.readFileSync(p, 'utf8');
    payloadData = JSON.parse(content);
    foundPath = p;
    console.log('Found payload at:', p);
    break;
  } catch (e) {
    console.log('No payload at:', p);
  }
}

if (!payloadData) {
  console.log('No payload found anywhere');
  console.log('Writing debug result...');
  
  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify({
      success: false,
      error: 'Cannot find payload file',
      spec: 'Payload not found — check logs',
      confidence: {
        score: 0, risk: 'HIGH',
        summary: 'Cannot find payload',
        assumption: 'None',
        uncertain: 'Everything'
      }
    })
  );
  process.exit(0);
}

console.log('Payload keys:', Object.keys(payloadData).join(', '));

const intake = (
  payloadData['Stage 1 - Intake'] &&
  payloadData['Stage 1 - Intake'].data &&
  payloadData['Stage 1 - Intake'].data.body &&
  payloadData['Stage 1 - Intake'].data.body.data
) || {};

const title = intake.title || 'No title found';
const body  = intake.body  || 'No body found';

console.log('Title:', title);
console.log('Body preview:', body.substring(0, 100));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = `You are a senior software engineer writing a
detailed technical specification for the following GitHub issue.

ISSUE TITLE: ${title}

ISSUE BODY:
${body}

Write a detailed technical spec with these EXACT section headers:

SUMMARY
(one clear sentence describing what to build)

REQUIREMENTS
(bullet list of specific requirements)

IMPLEMENTATION PLAN
(numbered step by step implementation guide)

FILES TO CREATE/MODIFY
(list every file that needs to be created or changed)

ACCEPTANCE CRITERIA
(how to verify the implementation is complete and correct)

Be concrete, specific, and practical.
Do not truncate — write the complete spec.`;

(async () => {
  console.log('Calling Claude Sonnet...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const block = response.content.find(b => b.type === 'text')
    || response.content[0];
  const spec = (block && block.text) || '';

  console.log('Spec length:', spec.length);
  console.log('Word count:', spec.split(' ').length);

  const wordCount = spec.split(' ').length;
  const hasAllSections = [
    'SUMMARY', 'REQUIREMENTS', 'IMPLEMENTATION',
    'FILES', 'ACCEPTANCE'
  ].every(s => spec.toUpperCase().includes(s));
  const hasBulletPoints = spec.includes('-')
    || spec.includes('•');
  const hasNumberedSteps = /\d+\./.test(spec);

  let score = 40;
  if (hasAllSections)   score += 25;
  if (wordCount > 200)  score += 15;
  if (wordCount > 400)  score += 10;
  if (hasBulletPoints)  score += 5;
  if (hasNumberedSteps) score += 5;
  score = Math.min(95, score);

  const risk = score >= 75 ? 'LOW'
    : score >= 50 ? 'MEDIUM' : 'HIGH';

  const result = {
    success: true,
    spec,
    confidence: {
      score,
      risk,
      summary: (hasAllSections
        ? `Complete spec with ${wordCount} words`
        : `Partial spec with ${wordCount} words`
      ).substring(0, 150),
      assumption: 'Issue has sufficient detail to spec',
      uncertain: 'Exact codebase architecture unknown'
    }
  };

  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify(result)
  );

  console.log('Result written to:', process.env.SUPERPLANE_RESULT_FILE);
  console.log('Score:', score, '| Risk:', risk);
  console.log('Stage 2 complete');

})().catch(err => {
  console.error('Spec Agent failed:', err);
  fs.writeFileSync(
    process.env.SUPERPLANE_RESULT_FILE,
    JSON.stringify({
      success: false,
      error: String(err),
      spec: '',
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