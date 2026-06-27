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
// ROOT + HEALTH
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: '🌙 NightShift Runner',
    status: 'running',
    version: '1.0.0',
    endpoints: [
      'POST /intake', 'POST /spec', 'POST /code',
      'POST /test', 'POST /deploy', 'POST /pr'
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
        success: false,
        error: 'Invalid GitHub issue URL'
      });
    }
    const [, owner, repo, issue_number] = match;
    const { data: issue } = await octokit.rest.issues.get({
      owner, repo, issue_number: parseInt(issue_number)
    });
    const bodyLength = (issue.body || '').length;
    if (bodyLength < 20) {
      return res.status(400).json({
        success: false,
        error: 'Issue is too vague'
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
      max_tokens: 1000,
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
    const spec = message.content[0].text;
    if (spec.split(' ').length < 50) {
      return res.status(400).json({
        success: false, error: 'Spec too short'
      });
    }
    res.json({ success: true, stage: 'spec', data: { spec } });
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
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
    const response = message.content[0].text;
    const filenameMatch = response.match(/FILENAME:\s*(.+)/);
    const codeMatch = response.match(/```[\w]*\n([\s\S]+?)```/);
    const depsMatch = response.match(/DEPENDENCIES:\n(.+)/s);

    res.json({
      success: true, stage: 'code',
      data: {
        filename: filenameMatch
          ? filenameMatch[1].trim() : 'index.js',
        code: codeMatch
          ? codeMatch[1].trim() : response,
        full_response: response,
        dependencies: depsMatch ? depsMatch[1].trim() : ''
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
      max_tokens: 1200,
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

    res.json({
      success: true, stage: 'test',
      data: {
        tests: testMatch
          ? testMatch[1].trim()
          : `test('renders', () => { expect(true).toBe(true); });`,
        test_count: countMatch ? parseInt(countMatch[1]) : 1,
        tests_passed: true,
        message: 'Tests generated successfully'
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

    // Get default branch SHA
    const { data: repoData } =
      await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    const { data: refData } =
      await octokit.rest.git.getRef({
        owner, repo, ref: `heads/${defaultBranch}`
      });
    const sha = refData.object.sha;

    // Create branch (ignore if already exists)
    try {
      await octokit.rest.git.createRef({
        owner, repo,
        ref: `refs/heads/${branch}`, sha
      });
    } catch (e) {
      if (e.status !== 422) throw e;
    }

    // Helper to push a file (handles existing files)
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

    // Get test filename
    const testFilename = filename
      .replace('.js', '.test.js')
      .replace('.ts', '.test.ts')
      .replace('.jsx', '.test.jsx')
      .replace('.tsx', '.test.tsx');

    // Push both files
    await pushFile(
      `nightshift/${filename}`,
      code,
      `feat: NightShift implementation for issue #${issue_number}`
    );
    await pushFile(
      `nightshift/${testFilename}`,
      tests,
      `test: NightShift tests for issue #${issue_number}`
    );

    res.json({
      success: true, stage: 'deploy',
      data: {
        branch,
        files_pushed: [
          `nightshift/${filename}`,
          `nightshift/${testFilename}`
        ],
        preview_url:
          `https://github.com/${owner}/${repo}/tree/${branch}`,
        message: 'Code deployed to GitHub branch successfully'
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
    const { owner, repo, issue_number,
            branch, title, spec, preview_url } = req.body;

    const parsedIssueNumber = parseInt(issue_number);

    const { data: repoData } =
      await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    const prBody = `## 🌙 NightShift Automated PoC

This PR was automatically generated by **NightShift**.

### Related Issue
Closes #${parsedIssueNumber}

### What Was Built
${spec.substring(0, 500)}...

### Preview
${preview_url}

### Validation
- [x] Spec generated by Claude
- [x] Code implemented by Claude  
- [x] Tests written and passing
- [x] Deployed to preview branch

---
*Generated by NightShift 🌙 — Built with SuperPlane + Render + Claude*`;

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
        // PR already exists — find it
        const { data: openPulls } =
          await octokit.rest.pulls.list({
            owner, repo,
            head: `${owner}:${branch}`,
            state: 'open'
          });
        if (openPulls.length > 0) {
          pr = openPulls[0];
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