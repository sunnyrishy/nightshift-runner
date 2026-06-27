const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// Debug — print all environment variables
console.log('=== ENVIRONMENT VARIABLES ===');
console.log('SUPERPLANE_PAYLOAD_FILE:', process.env.SUPERPLANE_PAYLOAD_FILE);
console.log('SUPERPLANE_RESULT_FILE:', process.env.SUPERPLANE_RESULT_FILE);
console.log('ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
console.log('All env keys:', Object.keys(process.env).join(', '));
console.log('=============================');

// Find payload file
const payloadPath = process.env.SUPERPLANE_PAYLOAD_FILE;

if (!payloadPath) {
  console.error('SUPERPLANE_PAYLOAD_FILE is not set!');
  console.log('Trying to find payload file...');
  
  // Try common locations
  const possiblePaths = [
    '/tmp/payload.json',
    '/payload.json',
    '/superplane/payload.json',
    '/tmp/superplane_payload.json'
  ];
  
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        console.log('Found payload at:', p);
        const content = fs.readFileSync(p, 'utf8');
        console.log('Payload preview:', content.substring(0, 200));
      }
    } catch (e) {
      console.log('Not at:', p);
    }
  }

  // List /tmp directory
  console.log('Files in /tmp:');
  try {
    const files = fs.readdirSync('/tmp');
    console.log(files.join(', '));
  } catch (e) {
    console.log('Cannot read /tmp');
  }

  // Write dummy result so pipeline continues
  const resultPath = process.env.SUPERPLANE_RESULT_FILE || '/tmp/result.json';
  fs.writeFileSync(resultPath, JSON.stringify({
    success: false,
    error: 'SUPERPLANE_PAYLOAD_FILE not set',
    spec: 'Debug mode - payload file not found',
    confidence: {
      score: 0, risk: 'HIGH',
      summary: 'Environment variable missing',
      assumption: 'None',
      uncertain: 'Everything'
    }
  }));
  process.exit(0);
}

const payload = JSON.parse(
  fs.readFileSync(payloadPath, 'utf8')
);

console.log('Payload keys:', Object.keys(payload).join(', '));

const intake = (
  payload['Stage 1 - Intake'] &&
  payload['Stage 1 - Intake'].data &&
  payload['Stage 1 - Intake'].data.body &&
  payload['Stage 1 - Intake'].data.body.data
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
  console.log('Calling Claude...');

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
  const hasBulletPoints = spec.includes('-') || spec.includes('•');
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

  const resultPath = process.env.SUPERPLANE_RESULT_FILE
    || '/tmp/result.json';

  fs.writeFileSync(resultPath, JSON.stringify(result));
  console.log('Result written to:', resultPath);
  console.log('Score:', score, '| Risk:', risk);
  console.log('Stage 2 complete');

})().catch(err => {
  console.error('Spec Agent failed:', err);
  const resultPath = process.env.SUPERPLANE_RESULT_FILE
    || '/tmp/result.json';
  fs.writeFileSync(resultPath, JSON.stringify({
    success: false,
    error: String(err),
    spec: '',
    confidence: {
      score: 0, risk: 'HIGH',
      summary: 'Stage failed',
      assumption: 'None',
      uncertain: 'Everything'
    }
  }));
  process.exit(1);
});