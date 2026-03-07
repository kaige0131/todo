require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const FEISHU_APP_ID     = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const SILICONFLOW_KEY   = process.env.SILICONFLOW_API_KEY;
const PORT              = process.env.PORT || 3000;

let _token = null, _tokenExpiry = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const r = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
  );
  _token = r.data.tenant_access_token;
  _tokenExpiry = Date.now() + (r.data.expire - 60) * 1000;
  return _token;
}

const buffer = {};

async function sendToGroup(chatId, markdown) {
  const token = await getToken();
  await axios.post(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: { title: { tag: "plain_text", content: "📋 TO-DO 任务提醒" }, template: "blue" },
        elements: [{ tag: "markdown", content: markdown }]
      })
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function analyzeTodos(messages) {
  const log = messages.map(m => `${m.sender}：${m.content}`).join("\n");
  const r = await axios.post(
    "https://api.siliconflow.cn/v1/chat/completions",
    {
      model: "Qwen/Qwen2.5-7B-Instruct",
      messages: [{
        role: "user",
        content: `分析飞书群聊，提取未完成TO-DO，返回纯JSON无多余文字：\n\n${log}\n\n格式：{"todos":[{"assignee":"人名","task":"任务描述","deadline":"截止时间或null","priority":"high/mid/low","reminder":"40字以内的提醒消息"}]}`
      }]
    },
    {
      headers: {
        "Authorization": `Bearer ${SILICONFLOW_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  const raw = r.data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw).todos || [];
}

function formatMessage(todos) {
  if (!todos.length) return null;
  const byPerson = {};
  todos.forEach(t => { (byPerson[t.assignee] = byPerson[t.assignee] || []).push(t); });
  let msg = "**🔍 当前待办任务汇总**\n\n";
  for (const [person, tasks] of Object.entries(byPerson)) {
    msg += `**@${person}**\n`;
    tasks.forEach(t => {
      const icon = t.priority === "high" ? "🔴" : t.priority === "mid" ? "🟡" : "🟢";
      msg += `${icon} ${t.task}`;
      if (t.deadline) msg += `  ｜ 📅 ${t.deadline}`;
      msg += `\n> ${t.reminder}\n\n`;
    });
  }
  return msg;
}

const seen = new Set();

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("收到请求:", JSON.stringify(body).slice(0, 500));

  if (body.type === "url_verification") return res.json({ challenge: body.challenge });

  const eid = body.header?.event_id;
  if (eid) {
    if (seen.has(eid)) { console.log("重复请求忽略"); return res.sendStatus(200); }
    seen.add(eid);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }

  res.sendStatus(200);

  const event = body.event;
  const eventType = body.header?.event_type;
  const msgType = event?.message?.message_type || event?.message?.msg_type;
  const chatType = event?.message?.chat_type;

  console.log("事件类型:", eventType);
  console.log("消息类型:", msgType);
  console.log("聊天类型:", chatType);

  if (eventType !== "im.message.receive_v1") return;
  if (chatType !== "group") return;
  if (msgType !== "text") return;

  const chatId = event.message.chat_id;
  let content = "";
  try {
    content = JSON.parse(event.message.content).text || "";
  } catch(e) {
    content = event.message.content || "";
  }
  const sender = event.sender?.sender_id?.open_id || "未知";
  console.log("消息内容:", content, "发送者:", sender);

  if (!buffer[chatId]) buffer[chatId] = [];
  buffer[chatId].push({ sender, content });
  if (buffer[chatId].length > 50) buffer[chatId].shift();

  const trimmed = content.trim().replace(/@\S+\s*/g, "").trim();
  if (trimmed !== "/todo") return;

  console.log("触发/todo，开始分析...");
  try {
    const todos = await analyzeTodos(buffer[chatId]);
    console.log("分析结果:", JSON.stringify(todos));
    const msg = formatMessage(todos);
    if (msg) await sendToGroup(chatId, msg);
    else await sendToGroup(chatId, "✅ 暂无待办任务，大家都完成啦！");
  } catch (err) {
    console.error("Error:", err.message, err.response?.data);
  }
});

app.get("/", (_, res) => res.send("飞书 TO-DO 机器人运行中 ✅"));
app.listen(PORT, () => console.log(`🚀 启动在端口 ${PORT}`));
