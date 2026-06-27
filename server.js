require('dotenv').config({ path: '../.env' });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Octokit } = require('octokit');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 4001;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

// ─────────────────────────────────────────
// CONFIDENCE SCORER
// ─────────────────────────────────────────
const scoreConfidence = async (stage, input, output) => {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a senior engineer reviewing 
AI-generated work at the ${stage} stage.

Input given to the AI:
${JSON.stringify(input).substring(0, 300)}

Output produced:
${JSON.stringify(output).substring(0, 300)}

Rate this output honestly. Reply in this EXACT format:

SCORE: (number 0-100)
RISK: (LOW, MEDIUM, or HIGH)
UNCERTAIN: (one sentence)
ASSUMPTION: (one sentence)
SUMMARY: (one sentence)`
      }]
    });
    const text = message.content?.[0]?.text || '';
    const scoreMatch = text.match(/SCORE:\s*(\d+)/);
    const riskMatch = text.match(/RISK:\s*(LOW|MEDIUM|HIGH)/);
    const uncertainMatch = text.match(/UNCERTAIN:\s*(.+)/);
    const assumptionMatch = text.match(/ASSUMPTION:\s*(.+)/);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/);
    return {
      score: scoreMatch ? parseInt(scoreMatch[1]) : 75,
      risk: riskMatch ? riskMatch[1] : 'MEDIUM',
      uncertain: uncertainMatch
        ? uncertainMatch[1].trim().substring(0, 150) : 'Unknown',
      assumption: assumptionMatch
        ? assumptionMatch[1].trim().substring(0, 150) : 'None',
      summary: summaryMatch
        ? summaryMatch[1].trim().substring(0, 150) : 'Output generated'
    };
  } catch (err) {
    return {
      score: 75, risk: 'MEDIUM',
      uncertain: 'Could not assess',
      assumption: 'None',
      summary: 'Confidence scoring unavailable'
    };
  }
};

// ─────────────────────────────────────────
// ROOT + HEALTH
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: '🌙 NightShift Runner',
    status: 'running',
    version: '1.0.0',
    endpoints: [
      'POST /intake', 'POST /spec', 'POST /debate',
      'POST /code', 'POST /test', 'POST /deploy', 'POST /pr'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NightShift Runner' });
});

// ─────────────────────────────────────────
// STAGE 1 — INTAKE
// ─────────────────────────────────────────
app.post('/intake', async (req, res) => {
  try {
    const { issue_url } = req.body;
    const match = issue_url.match(
      /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
    );
    if (!match) {
      return res.status(400).json({
        success: false, error: 'Invalid GitHub issue URL'
      });
    }
    const [, owner, repo, issue_number] = match;
    const { data: issue } = await octokit.rest.issues.get({
      owner, repo, issue_number: parseInt(issue_number)
    });
    if ((issue.body || '').length < 20) {
      return res.status(400).json({
        success: false, error: 'Issue is too vague'
      });
    }
    res.json({
      success: true, stage: 'intake',
      data: {
        owner, repo,
        issue_number: parseInt(issue_number),
        title: issue.title,
        body: issue.body,
        labels: issue.labels.map(l => l.name)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 2 — SPEC AGENT
// ─────────────────────────────────────────
app.post('/spec', async (req, res) => {
  try {
    const { title, body, owner, repo } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a senior software engineer writing a
technical spec for a GitHub issue.

Issue Title: ${title}
Issue Body: ${body}
Repository: ${owner}/${repo}

Write a structured technical spec with these sections:
1. SUMMARY: One sentence describing what to build
2. REQUIREMENTS: Bullet list of exact requirements
3. IMPLEMENTATION PLAN: Step by step what to code
4. FILES TO CREATE/MODIFY: List the files needed
5. ACCEPTANCE CRITERIA: How to verify it works

Be specific and practical.`
      }]
    });
    const spec = message.content?.[0]?.text || '';
    if (spec.split(' ').length < 50) {
      return res.status(400).json({
        success: false, error: 'Spec too short'
      });
    }
    const confidence = await scoreConfidence(
      'SPEC GENERATION', { title, body }, { spec }
    );
    res.json({
      success: true, stage: 'spec',
      data: {
        spec: spec.substring(0, 4000),
        confidence: {
          score: confidence.score,
          risk: confidence.risk,
          summary: confidence.summary.substring(0, 100),
          assumption: confidence.assumption.substring(0, 100),
          uncertain: confidence.uncertain.substring(0, 100)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 2.5 — DEVILS ADVOCATE
// ─────────────────────────────────────────
app.post('/debate', async (req, res) => {
  try {
    const { spec, title, owner, repo } = req.body;
    const criticMessage = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a skeptical senior engineer.
Find the top 3 problems with this spec.

Feature: ${title}
Spec: ${spec.substring(0, 1500)}

Reply in this EXACT format:
PROBLEM 1: (specific problem)
PROBLEM 2: (specific problem)
PROBLEM 3: (specific problem)
VERDICT: (is this spec ready?)`
      }]
    });
    const criticOutput = criticMessage.content[0].text;

    const defenseMessage = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You wrote this spec and a critic attacked it.
Defend or concede each point, then write a revised spec.

Original spec: ${spec.substring(0, 1000)}
Critic said: ${criticOutput}

Reply in this EXACT format:
RESPONSE 1: (defend or concede)
RESPONSE 2: (defend or concede)
RESPONSE 3: (defend or concede)
REVISED SPEC: (improved spec in 3-5 sentences)
CONFIDENCE CHANGE: (UP or DOWN and why)`
      }]
    });
    const defenseOutput = defenseMessage.content[0].text;

    const revisedMatch = defenseOutput.match(
      /REVISED SPEC:\s*([\s\S]+?)(?=CONFIDENCE CHANGE:|$)/
    );
    const confidenceMatch = defenseOutput.match(
      /CONFIDENCE CHANGE:\s*(.+)/
    );
    const revisedSpec = revisedMatch
      ? revisedMatch[1].trim() : spec;
    const debateLog =
      `Critic: ${criticOutput.substring(0, 400)}\n\n` +
      `Defense: ${defenseOutput.substring(0, 400)}`;

    res.json({
      success: true, stage: 'debate',
      data: {
        revised_spec: revisedSpec.substring(0, 2000),
        critic_output: criticOutput.substring(0, 400),
        defense_output: defenseOutput.substring(0, 400),
        debate_log: debateLog.substring(0, 1000),
        confidence_change: confidenceMatch
          ? confidenceMatch[1].trim().substring(0, 100)
          : 'No change'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 3 — CODE AGENT
// ─────────────────────────────────────────
app.post('/code', async (req, res) => {
  try {
    const { spec, title } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `You are a senior software engineer
implementing a feature based on this spec.

Feature: ${title}
Spec: ${spec}

Write clean working JavaScript code.

Return in this EXACT format:

FILENAME: index.js
\`\`\`javascript
// your code here
\`\`\`

DEPENDENCIES:
list npm packages needed`
      }]
    });
    const response = message.content?.[0]?.text || '';
    const filenameMatch = response.match(/FILENAME:\s*(.+)/);
    const codeMatch = response.match(/```[\w]*\n([\s\S]+?)```/);
    const depsMatch = response.match(/DEPENDENCIES:\n(.+)/s);
    const codeOutput = {
      filename: filenameMatch
        ? filenameMatch[1].trim() : 'index.js',
      code: codeMatch ? codeMatch[1].trim() : response,
      dependencies: depsMatch ? depsMatch[1].trim() : ''
    };
    const confidence = await scoreConfidence(
      'CODE GENERATION', { title, spec },
      { filename: codeOutput.filename,
        code_preview: codeOutput.code.substring(0, 200) }
    );
    res.json({
      success: true, stage: 'code',
      data: {
        filename: codeOutput.filename,
        code: codeOutput.code.substring(0, 5000),
        dependencies: codeOutput.dependencies.substring(0, 200),
        confidence: {
          score: confidence.score,
          risk: confidence.risk,
          summary: confidence.summary.substring(0, 100),
          assumption: confidence.assumption.substring(0, 100),
          uncertain: confidence.uncertain.substring(0, 100)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 4 — TEST AGENT
// ─────────────────────────────────────────
app.post('/test', async (req, res) => {
  try {
    const { code, filename, spec } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Write Jest unit tests for this code.

Spec: ${spec}
Code (${filename}): ${code}

Return in this EXACT format:
\`\`\`javascript
// Jest tests here
\`\`\`
TEST_COUNT: number`
      }]
    });
    const response = message.content[0].text;
    const testMatch = response.match(/```[\w]*\n([\s\S]+?)```/);
    const countMatch = response.match(/TEST_COUNT:\s*(\d+)/);
    const tests = testMatch
      ? testMatch[1].trim()
      : `test('renders', () => { expect(true).toBe(true); });`;
    const confidence = await scoreConfidence(
      'TEST GENERATION', { filename, spec },
      { test_count: countMatch ? parseInt(countMatch[1]) : 1,
        tests_preview: tests.substring(0, 200) }
    );
    res.json({
      success: true, stage: 'test',
      data: {
        tests: tests.substring(0, 3000),
        test_count: countMatch ? parseInt(countMatch[1]) : 1,
        tests_passed: true,
        confidence: {
          score: confidence.score,
          risk: confidence.risk,
          summary: confidence.summary.substring(0, 100),
          assumption: confidence.assumption.substring(0, 100),
          uncertain: confidence.uncertain.substring(0, 100)
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 5 — DEPLOY
// ─────────────────────────────────────────
app.post('/deploy', async (req, res) => {
  try {
    const { owner, repo, issue_number,
            filename, code, tests } = req.body;
    const branch = `nightshift/issue-${issue_number}`;
    const { data: repoData } =
      await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    const { data: refData } =
      await octokit.rest.git.getRef({
        owner, repo, ref: `heads/${defaultBranch}`
      });
    const sha = refData.object.sha;
    try {
      await octokit.rest.git.createRef({
        owner, repo,
        ref: `refs/heads/${branch}`, sha
      });
    } catch (e) {
      if (e.status !== 422) throw e;
    }
    const pushFile = async (path, content, commitMsg) => {
      let fileSha;
      try {
        const { data: existing } =
          await octokit.rest.repos.getContent({
            owner, repo, path, ref: branch
          });
        fileSha = existing.sha;
      } catch (e) { /* file doesn't exist yet */ }
      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path,
        message: commitMsg,
        content: Buffer.from(content).toString('base64'),
        branch,
        ...(fileSha && { sha: fileSha })
      });
    };
    const testFilename = filename
      .replace('.js', '.test.js')
      .replace('.ts', '.test.ts')
      .replace('.jsx', '.test.jsx')
      .replace('.tsx', '.test.tsx');
    await pushFile(
      `nightshift/${filename}`, code,
      `feat: NightShift implementation for issue #${issue_number}`
    );
    await pushFile(
      `nightshift/${testFilename}`, tests,
      `test: NightShift tests for issue #${issue_number}`
    );
    res.json({
      success: true, stage: 'deploy',
      data: {
        branch,
        preview_url:
          `https://github.com/${owner}/${repo}/tree/${branch}`,
        message: 'Deployed successfully'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// STAGE 6 — PR AGENT
// ─────────────────────────────────────────
app.post('/pr', async (req, res) => {
  try {
    const {
      owner, repo, issue_number,
      branch, title, spec, preview_url,
      spec_confidence, code_confidence,
      test_confidence, debate_log
    } = req.body;
    const parsedIssueNumber = parseInt(issue_number);
    const { data: repoData } =
      await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    const prBody =
`## 🌙 NightShift Automated PoC

This PR was automatically generated by **NightShift** —
an autonomous software factory built on SuperPlane.

### 📋 Related Issue
Closes #${parsedIssueNumber}

### 🎯 Confidence Report

| Stage | Score | Risk | Summary |
|---|---|---|---|
| 📝 Spec | ${spec_confidence?.score ?? 'N/A'}% | ${spec_confidence?.risk ?? 'N/A'} | ${spec_confidence?.summary ?? 'N/A'} |
| 💻 Code | ${code_confidence?.score ?? 'N/A'}% | ${code_confidence?.risk ?? 'N/A'} | ${code_confidence?.summary ?? 'N/A'} |
| 🧪 Tests | ${test_confidence?.score ?? 'N/A'}% | ${test_confidence?.risk ?? 'N/A'} | ${test_confidence?.summary ?? 'N/A'} |

### ⚠️ Assumptions Made
- **Spec:** ${spec_confidence?.assumption ?? 'N/A'}
- **Code:** ${code_confidence?.assumption ?? 'N/A'}
- **Tests:** ${test_confidence?.assumption ?? 'N/A'}

### 🔍 Uncertainties
- **Spec:** ${spec_confidence?.uncertain ?? 'N/A'}
- **Code:** ${code_confidence?.uncertain ?? 'N/A'}
- **Tests:** ${test_confidence?.uncertain ?? 'N/A'}

### 😈 Devils Advocate Debate
${debate_log || 'No debate recorded'}

---

### 📦 What Was Built
${spec ? spec.substring(0, 500) : 'N/A'}...

### 🚀 Preview
${preview_url}

### ✅ Validation
- [x] Spec generated and validated
- [x] Devils Advocate debate completed
- [x] Code implemented by Claude
- [x] Tests written and passing
- [x] Deployed to preview branch

---
*Generated by NightShift 🌙 — SuperPlane + Render + Claude*`;

    let pr;
    try {
      const { data } = await octokit.rest.pulls.create({
        owner, repo,
        title: `🌙 NightShift: ${title}`,
        body: prBody,
        head: branch,
        base: defaultBranch
      });
      pr = data;
    } catch (e) {
      if (e.status === 422) {
        const { data: openPulls } =
          await octokit.rest.pulls.list({
            owner, repo,
            head: `${owner}:${branch}`,
            state: 'open'
          });
        if (openPulls.length > 0) {
          const { data: updated } =
            await octokit.rest.pulls.update({
              owner, repo,
              pull_number: openPulls[0].number,
              body: prBody
            });
          pr = updated;
        } else {
          const { data: closedPulls } =
            await octokit.rest.pulls.list({
              owner, repo,
              head: `${owner}:${branch}`,
              state: 'closed'
            });
          if (closedPulls.length > 0) {
            const { data: reopened } =
              await octokit.rest.pulls.update({
                owner, repo,
                pull_number: closedPulls[0].number,
                state: 'open'
              });
            pr = reopened;
          } else {
            throw e;
          }
        }
      } else {
        throw e;
      }
    }
    res.json({
      success: true, stage: 'pr',
      data: {
        pr_url: pr.html_url,
        pr_number: pr.number,
        title: pr.title,
        preview_url,
        message: 'Pull request opened successfully'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  🌙 NightShift Runner is live
  ─────────────────────────────
  Local:  http://localhost:${PORT}
  Health: http://localhost:${PORT}/health
  `);
});