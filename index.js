require("dotenv").config();
const axios = require("axios");

const FEISHU_APP_ID     = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const SILICONFLOW_KEY   = process.env.SILICONFLOW_API_KEY;

const lark = require("@larksuiteoapi/node-sdk");

const client = new lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

const wsClient = new lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
});

const buffer = {};

async function sendToGroup(chatId, markdown) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: { title: { tag: "plain_text", content: "📋 TO-DO 任务提醒" }, template: "blue" },
        elements: [{ tag: "markdown", content: markdown }]
      })
    }
  });
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

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const msg = data.message;
      console.log("收到消息:", JSON.stringify(msg).slice(0, 300));
      if (msg.chat_type !== "group") return;
      if (msg.message_type !== "text") return;

      const chatId = msg.chat_id;
      let content = "";
      try { content = JSON.parse(msg.content).text || ""; }
      catch(e) { content = msg.content || ""; }
      const sender = data.sender?.sender_id?.open_id || "未知";
      console.log("内容:", content);

      if (!buffer[chatId]) buffer[chatId] = [];
      buffer[chatId].push({ sender, content });
      if (buffer[chatId].length > 50) buffer[chatId].shift();

      const trimmed = content.replace(/@\S+\s*/g, "").trim();
      if (trimmed !== "/todo") return;

      console.log("触发/todo，分析中...");
      try {
        const todos = await analyzeTodos(buffer[chatId]);
        const msg2 = formatMessage(todos);
        if (msg2) await sendToGroup(chatId, msg2);
        else await sendToGroup(chatId, "✅ 暂无待办任务！");
      } catch(err) {
        console.error("Error:", err.message);
      }
    }
  })
});

console.log("🚀 飞书长连接机器人启动");
