import fs from "node:fs/promises";

function clone(value) {
  return structuredClone(value);
}

function getNode(workflow, id) {
  if (id === undefined || id === null || id === "") return null;
  return workflow[String(id)] ?? null;
}

function isNodeReference(value, workflow) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "string" &&
    Object.prototype.hasOwnProperty.call(workflow, value[0])
  );
}

function findSamplerId(workflow, explicitId) {
  if (explicitId && getNode(workflow, explicitId)) {
    return String(explicitId);
  }

  const entries = Object.entries(workflow);

  const direct = entries.find(([, node]) =>
    /ksampler/i.test(String(node?.class_type ?? ""))
  );
  if (direct) return direct[0];

  const semantic = entries.find(([, node]) => {
    const inputs = node?.inputs ?? {};
    return (
      Object.prototype.hasOwnProperty.call(inputs, "positive") &&
      Object.prototype.hasOwnProperty.call(inputs, "negative") &&
      (
        Object.prototype.hasOwnProperty.call(inputs, "seed") ||
        Object.prototype.hasOwnProperty.call(inputs, "noise_seed") ||
        Object.prototype.hasOwnProperty.call(inputs, "steps")
      )
    );
  });

  return semantic?.[0] ?? null;
}

function findTextNodeFromReference(workflow, value, visited = new Set()) {
  if (!isNodeReference(value, workflow)) return null;

  const id = String(value[0]);
  if (visited.has(id)) return null;
  visited.add(id);

  const node = workflow[id];
  const inputs = node?.inputs ?? {};

  if (typeof inputs.text === "string") {
    return id;
  }

  const preferredKeys = [
    "conditioning",
    "positive",
    "negative",
    "clip",
    "prompt",
    "text",
  ];

  for (const key of preferredKeys) {
    if (!(key in inputs)) continue;
    const found = findTextNodeFromReference(workflow, inputs[key], visited);
    if (found) return found;
  }

  for (const input of Object.values(inputs)) {
    const found = findTextNodeFromReference(workflow, input, visited);
    if (found) return found;
  }

  return null;
}

function resolvePromptNodeId(workflow, samplerId, kind, explicitId) {
  if (explicitId && getNode(workflow, explicitId)) {
    return String(explicitId);
  }

  const sampler = getNode(workflow, samplerId);
  const ref = sampler?.inputs?.[kind];
  const linked = findTextNodeFromReference(workflow, ref);

  if (linked) return linked;

  const titleNeedle = kind === "positive" ? /positive|prompt/i : /negative/i;
  const byTitle = Object.entries(workflow).find(([, node]) => {
    const title = String(node?._meta?.title ?? "");
    return titleNeedle.test(title) && typeof node?.inputs?.text === "string";
  });

  if (byTitle) return byTitle[0];

  const textNodes = Object.entries(workflow).filter(
    ([, node]) => typeof node?.inputs?.text === "string"
  );

  if (kind === "positive") return textNodes[0]?.[0] ?? null;
  return textNodes[1]?.[0] ?? null;
}

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function setSeed(workflow, samplerId, requestedSeed) {
  const value =
    Number.isSafeInteger(requestedSeed) && requestedSeed >= 0
      ? requestedSeed
      : randomSeed();

  const sampler = getNode(workflow, samplerId);
  if (sampler?.inputs) {
    if (typeof sampler.inputs.seed === "number") {
      sampler.inputs.seed = value;
      return value;
    }

    if (typeof sampler.inputs.noise_seed === "number") {
      sampler.inputs.noise_seed = value;
      return value;
    }
  }

  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs;
    if (!inputs) continue;

    if (typeof inputs.seed === "number") {
      inputs.seed = value;
      return value;
    }

    if (typeof inputs.noise_seed === "number") {
      inputs.noise_seed = value;
      return value;
    }
  }

  return null;
}

export async function loadWorkflow(path) {
  const raw = await fs.readFile(path, "utf8");
  const workflow = JSON.parse(raw);

  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("workflow_api.json inválido.");
  }

  return workflow;
}

export function prepareWorkflow(
  template,
  {
    prompt,
    negative,
    seed,
    samplerNodeId,
    positiveNodeId,
    negativeNodeId,
  }
) {
  const workflow = clone(template);

  const samplerId = findSamplerId(workflow, samplerNodeId);
  if (!samplerId) {
    throw new Error(
      "Não encontrei o sampler do workflow. Defina SAMPLER_NODE_ID no .env."
    );
  }

  const positiveId = resolvePromptNodeId(
    workflow,
    samplerId,
    "positive",
    positiveNodeId
  );

  if (!positiveId || typeof workflow[positiveId]?.inputs?.text !== "string") {
    throw new Error(
      "Não encontrei o node do prompt positivo. Defina POSITIVE_NODE_ID no .env."
    );
  }

  workflow[positiveId].inputs.text = prompt;

  let resolvedNegativeId = null;
  if (negative !== undefined && negative !== null && negative !== "") {
    resolvedNegativeId = resolvePromptNodeId(
      workflow,
      samplerId,
      "negative",
      negativeNodeId
    );

    if (
      !resolvedNegativeId ||
      typeof workflow[resolvedNegativeId]?.inputs?.text !== "string"
    ) {
      throw new Error(
        "Você informou negative prompt, mas o node negativo não foi encontrado. Defina NEGATIVE_NODE_ID no .env."
      );
    }

    workflow[resolvedNegativeId].inputs.text = negative;
  }

  const usedSeed = setSeed(workflow, samplerId, seed);

  return {
    workflow,
    metadata: {
      samplerId,
      positiveId,
      negativeId: resolvedNegativeId,
      seed: usedSeed,
    },
  };
}
