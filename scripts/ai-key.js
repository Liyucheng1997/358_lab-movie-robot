#!/usr/bin/env node
// 设置站点自带 AI 用的 Claude API Key（存在 DATA_DIR/anthropic-key，权限 600，改完不用重启）
//   node scripts/ai-key.js          交互输入 Key（不回显），保存前先向 Anthropic 验证一次
//   node scripts/ai-key.js status   看有没有配置（只显示末 4 位）
//   node scripts/ai-key.js remove   删除，AI 功能恢复为各人填自己的 Key
const readline = require('readline');
const ai = require('../src/ai');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const key = ai.getKey();
    console.log(key ? `已配置（…${key.slice(-4)}）` : '没有配置');
    return;
  }
  if (cmd === 'remove') {
    ai.saveKey('');
    console.log('已删除');
    return;
  }
  const key = process.env.NEW_KEY || (await askHidden('Claude API Key（输入不显示）: '));
  if (!/^sk-ant-\S{10,}$/.test(key)) throw new Error('Key 应以 sk-ant- 开头');
  // 用最便宜的方式验证：数一下 token，不产生费用
  const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: Object.keys(ai.MODELS)[0], messages: [{ role: 'user', content: 'hi' }] }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (r.status === 401) throw new Error('Anthropic 说这个 Key 无效，没有保存');
  if (!r.ok) console.warn(`提示：验证请求返回 ${r.status}（${(await r.text()).slice(0, 200)}），仍然保存。`);
  ai.saveKey(key);
  console.log(`已保存（…${key.slice(-4)}），马上生效`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
