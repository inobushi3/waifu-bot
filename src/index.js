import "dotenv/config";
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { ComfyClient } from "./comfy.js";
import { loadWorkflow, prepareWorkflow } from "./workflow.js";

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(`Faltando no .env: ${missing.join(", ")}`);
  process.exit(1);
}

const workflowPath = process.env.WORKFLOW_PATH || "./workflow_api.json";
const comfyUrl = process.env.COMFY_URL || "http://127.0.0.1:8188";
const generationTimeoutMs = Number(
  process.env.GENERATION_TIMEOUT_MS || "600000"
);

const activeUsers = new Set();
const comfy = new ComfyClient(comfyUrl, generationTimeoutMs);

const command = new SlashCommandBuilder()
  .setName("gerar")
  .setDescription("Gera uma imagem usando o ComfyUI")
  .addStringOption((option) =>
    option
      .setName("prompt")
      .setDescription("Descreva a imagem que você quer gerar")
      .setRequired(true)
      .setMaxLength(1800)
  )
  .addStringOption((option) =>
    option
      .setName("negativo")
      .setDescription("Negative prompt opcional")
      .setRequired(false)
      .setMaxLength(1200)
  )
  .addIntegerOption((option) =>
    option
      .setName("seed")
      .setDescription("Seed opcional; se vazio, usa uma seed aleatória")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(2_147_483_647)
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const body = [command.toJSON()];

  if (process.env.DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body }
    );
    console.log(
      `Comando /gerar registrado no servidor ${process.env.DISCORD_GUILD_ID}.`
    );
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body,
    });
    console.log("Comando global /gerar registrado.");
  }
}

function truncate(text, max = 900) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function handleGenerate(interaction) {
  if (
    process.env.ALLOWED_CHANNEL_ID &&
    interaction.channelId !== process.env.ALLOWED_CHANNEL_ID
  ) {
    await interaction.reply({
      content: "Esse comando não está liberado neste canal.",
      ephemeral: true,
    });
    return;
  }

  if (activeUsers.has(interaction.user.id)) {
    await interaction.reply({
      content: "Você já tem uma imagem sendo gerada. Aguarde ela terminar.",
      ephemeral: true,
    });
    return;
  }

  const prompt = interaction.options.getString("prompt", true).trim();
  const negative = interaction.options.getString("negativo")?.trim();
  const seed = interaction.options.getInteger("seed");

  activeUsers.add(interaction.user.id);
  await interaction.deferReply();

  try {
    const template = await loadWorkflow(workflowPath);

    const { workflow, metadata } = prepareWorkflow(template, {
      prompt,
      negative,
      seed,
      samplerNodeId: process.env.SAMPLER_NODE_ID,
      positiveNodeId: process.env.POSITIVE_NODE_ID,
      negativeNodeId: process.env.NEGATIVE_NODE_ID,
    });

    await interaction.editReply(
      `🎨 **Waifu-bot está desenhando...**\n> ${truncate(prompt, 500)}`
    );

    const result = await comfy.generate(workflow);

    const files = result.images.map(
      (image, index) =>
        new AttachmentBuilder(image.buffer, {
          name: image.filename || `waifu-bot-${index + 1}.png`,
        })
    );

    const seedLine =
      metadata.seed === null ? "" : `\n🌱 Seed: \`${metadata.seed}\``;

    await interaction.editReply({
      content: `✨ **Pronto!**\n> ${truncate(prompt, 900)}${seedLine}`,
      files,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);

    await interaction.editReply({
      content: `❌ Não consegui gerar a imagem.\n\`\`\`\n${truncate(message, 1500)}\n\`\`\``,
      files: [],
    });
  } finally {
    activeUsers.delete(interaction.user.id);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Waifu-bot online como ${readyClient.user.tag}`);
  console.log(`ComfyUI: ${comfyUrl}`);
  console.log(`Workflow: ${workflowPath}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "gerar") return;

  try {
    await handleGenerate(interaction);
  } catch (error) {
    console.error("Erro não tratado no comando /gerar:", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Ocorreu um erro inesperado.",
        ephemeral: true,
      });
    }
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

await registerCommands();
await client.login(process.env.DISCORD_TOKEN);
