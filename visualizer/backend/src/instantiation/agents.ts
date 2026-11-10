// Agent dispatch for a workflow step (localAssetStorageStack ROADMAP phase 9),
// behind one interface, so phase 8's per-clone OpenClaw agents
// (localOpenClawStack#91) plug in where the simulated agent sits now.
//
// The simulated agent sets the pattern every agent dispatch follows (owner,
// 2026-11-09):
// 1. it is handed the assetID (the frame), the step's capability and its
//    scopes, and the clone it runs beside; nothing else;
// 2. it reads its frame with the capability (`GET /frames/:id`);
// 3. it reads the frame's documents only through the lifecycle's `/pod`
//    proxy, and writes one only with `pod:write`, under the pinned ETag;
// 4. it writes its result to the frame (`PUT /frames/:id/return`);
// 5. it answers the dispatcher with whether the step needs an independent
//    review. It never resumes, captures, approves or closes anything: those
//    belong to the dispatcher and to people.
import { createHash } from 'crypto';

export interface AgentDispatch {
  frameId: string;
  continuationId: string;
  capability: string;
  scopes: string[];
  clone: { cloneId: string; engineId: string; templateId: string; envelopeId: string };
}

export interface AgentResult {
  /** The step's work needs an independent reviewer before the next one. */
  requestReview: boolean;
  /** What the agent wrote to the frame's return. */
  returned: unknown;
}

export interface AgentDriver {
  readonly name: string;
  dispatch(d: AgentDispatch): Promise<AgentResult>;
}

/** The lifecycle as an agent sees it: only through its capability. */
export interface AgentLifecycle {
  frame(frameId: string, capability: string): Promise<{
    documents: { uri: string; sha256: string; revision: string }[];
    action: unknown;
    observed?: { approved?: boolean };
  }>;
  readDocument(uri: string, capability: string): Promise<Buffer>;
  writeReturn(frameId: string, capability: string, value: unknown): Promise<void>;
}

/**
 * Reads its frame and every document through /pod, checks each against its
 * pin, and returns what it read. It asks for review until the frame has been
 * approved once, so a workflow passes one independent review before it
 * continues.
 */
export class SimulatedAgent implements AgentDriver {
  readonly name = 'simulated';
  constructor(private readonly lifecycle: AgentLifecycle) {}

  async dispatch(d: AgentDispatch): Promise<AgentResult> {
    const frame = await this.lifecycle.frame(d.frameId, d.capability);
    const documents = [];
    if (d.scopes.includes('pod:read')) {
      for (const doc of frame.documents) {
        const bytes = await this.lifecycle.readDocument(doc.uri, d.capability);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        documents.push({ uri: doc.uri, revision: doc.revision, sha256, matchesPin: sha256 === doc.sha256, bytes: bytes.length });
      }
    }
    const returned = {
      agent: this.name,
      template: d.clone.templateId,
      clone: d.clone.cloneId,
      continuation: d.continuationId,
      action: frame.action ?? null,
      documents
    };
    await this.lifecycle.writeReturn(d.frameId, d.capability, returned);
    return { requestReview: !frame.observed?.approved, returned };
  }
}
