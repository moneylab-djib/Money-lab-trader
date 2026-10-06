// Strict checks of a Messages API request body (rules for claude-sonnet-5-5),
// shared by the end-to-end harness and the chaos run.
// ─── Strict Anthropic validation (Messages API rules for claude-sonnet-5-5) ───
export function validate(body) {
  const errs = [];
  if (typeof body.model !== "string") errs.push("model missing");
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 128000) errs.push(`bad max_tokens ${body.max_tokens}`);
  if (body.max_tokens > 21333) errs.push("non-streaming max_tokens above the SDK 10-minute limit");
  if (body.temperature !== undefined && body.temperature !== 1) errs.push("non-default temperature on Sonnet 5.5");
  if (body.top_p !== undefined || body.top_k !== undefined) errs.push("sampling params on Sonnet 5.5");
  if (body.thinking && !["adaptive", "between_tools"].includes(body.thinking.type)) errs.push(`thinking ${body.thinking.type}`);
  if (body.tool_choice && !["auto", "none"].includes(body.tool_choice.type)) errs.push(`forced tool_choice ${body.tool_choice.type}`);
  if (body.output_config?.effort && !["low", "medium", "high", "xhigh", "max"].includes(body.output_config.effort)) errs.push("bad effort");
  let breakpoints = 0;
  const countCc = (b) => { if (b && b.cache_control) breakpoints++; };
  if (body.cache_control) breakpoints++;
  if (Array.isArray(body.system)) {
    for (const b of body.system) {
      countCc(b);
      if (b.type !== "text" || typeof b.text !== "string" || !b.text.trim()) errs.push("empty/invalid system block");
    }
  } else if (body.system !== undefined && (typeof body.system !== "string" || !body.system.trim())) errs.push("empty system");
  const names = new Set();
  for (const t of body.tools || []) {
    countCc(t);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(t.name)) errs.push(`bad tool name ${t.name}`);
    if (names.has(t.name)) errs.push(`duplicate tool ${t.name}`);
    names.add(t.name);
    if (typeof t.type === "string") {
      // Server tools (web search/fetch) have a type and no schema.
      if (!/^web_(search|fetch)_\d{8}$/.test(t.type)) errs.push(`unknown server tool ${t.type}`);
      continue;
    }
    if (!t.input_schema || t.input_schema.type !== "object") errs.push(`tool ${t.name} schema not object`);
    if (typeof t.description !== "string") errs.push(`tool ${t.name} without description`);
  }
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) errs.push("no messages");
  else {
    if (msgs[0].role !== "user") errs.push("first message is not user");
    // A trailing mid-conversation system message must follow a user turn.
    const lastConv = msgs.at(-1).role === "system" ? msgs.at(-2) : msgs.at(-1);
    if (!lastConv || lastConv.role !== "user") errs.push("last message is not user (prefill rejected)");
    msgs.forEach((m, i) => {
      if (m.role === "system") {
        if (i !== msgs.length - 1 && msgs[i + 1]?.role !== "assistant") errs.push(`messages.${i}: system message not last`);
        if (i === 0 || msgs[i - 1].role !== "user") errs.push(`messages.${i}: system message must follow a user turn`);
        if (typeof m.content !== "string" || !m.content.trim()) errs.push(`messages.${i}: empty system message`);
        return;
      }
      if (!["user", "assistant"].includes(m.role)) errs.push(`messages.${i}: role ${m.role}`);
      if (i > 0 && msgs[i - 1].role === m.role) errs.push(`messages.${i}: consecutive ${m.role} turns`);
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      if (!Array.isArray(blocks) || blocks.length === 0) errs.push(`messages.${i}: empty content`);
      for (const b of blocks || []) {
        countCc(b);
        if (b.type === "text" && (typeof b.text !== "string" || !b.text.trim())) errs.push(`messages.${i}: empty text block`);
        if (b.type === "tool_use") {
          if (m.role !== "assistant") errs.push(`messages.${i}: tool_use in user turn`);
          if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) errs.push(`messages.${i}: tool_use input not object`);
          if (!names.has(b.name)) errs.push(`messages.${i}: tool_use of undeclared tool ${b.name}`);
        }
        if (b.type === "tool_result" && m.role !== "user") errs.push(`messages.${i}: tool_result in assistant turn`);
        if (b.type === "thinking" || b.type === "redacted_thinking") errs.push(`messages.${i}: thinking block replayed`);
      }
      const uses = (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (m.role === "assistant" && uses.length) {
        const next = msgs[i + 1];
        const nb = next && Array.isArray(next.content) ? next.content : [];
        const lead = nb.slice(0, uses.length).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
        if (JSON.stringify([...lead].sort()) !== JSON.stringify([...uses].sort())) {
          errs.push(`messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after`);
        }
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        const prevUses = new Set((i > 0 && Array.isArray(msgs[i - 1].content) ? msgs[i - 1].content : [])
          .filter((b) => b.type === "tool_use").map((b) => b.id));
        let seenOther = false;
        for (const b of m.content) {
          if (b.type === "tool_result") {
            if (seenOther) errs.push(`messages.${i}: tool_result after other content`);
            if (!prevUses.has(b.tool_use_id)) errs.push(`messages.${i}: unexpected tool_use_id ${b.tool_use_id}`);
          } else seenOther = true;
        }
      }
    });
  }
  if (breakpoints > 4) errs.push(`${breakpoints} cache breakpoints (max 4)`);
  return errs;
}

