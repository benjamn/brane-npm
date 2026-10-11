/** ChatGPT export parser for brane absorb */

import type { AbsorbProvider, AbsorbedConversation, AbsorbedMessage } from "./types.js";

/** A node in ChatGPT's conversation tree */
interface ChatGPTNode {
  id: string;
  message: {
    id: string;
    author: { role: string; name?: string };
    create_time: number | null;
    update_time: number | null;
    content: { content_type: string; parts?: unknown[] };
    metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
    end_turn?: boolean;
    weight?: number;
    recipient?: string;
  } | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
  current_node: string;
}

/** Internal message with node ID for building re: references */
interface MessageWithNodeId extends AbsorbedMessage {
  _nodeId: string;
  _parentNodeId: string | null;
}

/**
 * Extract all messages from the conversation tree, preserving DAG topology.
 *
 * Strategy: DFS the entire tree from root. All messages get linearized by
 * timestamp (seq order), but branch points are preserved via re: references.
 * Each message's re: points to its parent message's eventual seq position.
 */
function linearize(conv: ChatGPTConversation): AbsorbedMessage[] {
  // Find root node (no parent)
  let rootId: string | null = null;
  for (const [id, node] of Object.entries(conv.mapping)) {
    if (!node.parent) {
      rootId = id;
      break;
    }
  }
  if (!rootId) return [];

  // DFS to collect all messages
  const allMessages: MessageWithNodeId[] = [];
  const stack: string[] = [rootId];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node: ChatGPTNode | undefined = conv.mapping[nodeId];
    if (!node) continue;

    if (node.message) {
      if (!node.message.metadata?.is_visually_hidden_from_conversation) {
        const role = normalizeRole(node.message.author.role);
        if (role) {
          const { text, assetPointers } = extractContent(node.message.content);

          // Include message if it has text content or asset pointers
          if (text || assetPointers.length > 0) {
            const time = node.message.create_time
              ? Math.round(node.message.create_time * 1000)
              : Math.round(conv.create_time * 1000);

            const msg: MessageWithNodeId = {
              role,
              content: text || "",
              time,
              model: node.message.metadata?.model_slug,
              _nodeId: node.id,
              _parentNodeId: node.parent,
            };
            if (assetPointers.length > 0) {
              msg.assetPointers = assetPointers;
            }
            allMessages.push(msg);
          }
        }
      }
    }

    // Push children in reverse so first child is processed first
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }

  // Sort by timestamp for linear seq ordering
  allMessages.sort((a, b) => a.time - b.time);

  // Build nodeId → seq mapping
  const nodeToSeq = new Map<string, number>();
  for (let i = 0; i < allMessages.length; i++) {
    nodeToSeq.set(allMessages[i]._nodeId, i + 1); // seq is 1-based
  }

  // Convert to AbsorbedMessage with re: references
  const result: AbsorbedMessage[] = [];
  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    const { _nodeId: _, _parentNodeId, ...clean } = msg;

    // Add re: reference to parent message (if parent produced a message)
    if (_parentNodeId) {
      const parentSeq = nodeToSeq.get(_parentNodeId);
      // Only add re: for non-sequential parents (branch points)
      // If parent is the immediately preceding message, re: is redundant
      if (typeof parentSeq === "number" && parentSeq !== i) {
        clean.re = [parentSeq];
      }
    }

    result.push(clean);
  }

  return result;
}

function normalizeRole(role: string): AbsorbedMessage["role"] | null {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "system": return "system";
    case "tool": return "tool";
    default: return null;
  }
}

interface ExtractedContent {
  text: string | null;
  assetPointers: string[];
}

function extractContent(content: { content_type: string; parts?: unknown[] }): ExtractedContent {
  if (!content.parts || content.parts.length === 0) return { text: null, assetPointers: [] };

  const textParts: string[] = [];
  const assetPointers: string[] = [];

  for (const part of content.parts) {
    if (typeof part === "string") {
      textParts.push(part);
    } else if (typeof part === "object" && part !== null) {
      const obj = part as Record<string, unknown>;
      // Image and audio asset pointers
      if (typeof obj.asset_pointer === "string") {
        assetPointers.push(obj.asset_pointer);
      }
      // Audio transcriptions — extract as text
      if (obj.content_type === "audio_transcription" && typeof obj.text === "string") {
        textParts.push(obj.text);
      }
    }
  }

  return {
    text: textParts.join("\n") || null,
    assetPointers,
  };
}

/** Count model usage across all messages */
function countModels(messages: AbsorbedMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    if (msg.model) {
      counts[msg.model] = (counts[msg.model] || 0) + 1;
    }
  }
  return counts;
}

/** Find the most common model in a conversation */
function dominantModel(messages: AbsorbedMessage[]): string | undefined {
  const counts = countModels(messages);
  let best: string | undefined;
  let bestCount = 0;
  for (const [model, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

export const chatgptProvider: AbsorbProvider = {
  name: "chatgpt",

  parseOne(raw: unknown): AbsorbedConversation | null {
    const conv = raw as ChatGPTConversation;
    if (!conv.mapping || !conv.current_node) return null;

    const messages = linearize(conv);
    if (messages.length === 0) return null;

    return {
      externalId: conv.id,
      title: conv.title || null,
      createdAt: Math.round(conv.create_time * 1000),
      updatedAt: Math.round(conv.update_time * 1000),
      messages,
      model: dominantModel(messages),
    };
  },
};
