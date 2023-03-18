import { getRevealButton, getUsageButton, simpleEmbed } from "$core/utils/Embed";
import { buildQuestion, AskContextOptions, Locales, BuildQuestionContext, BuildQuestionLanguage } from "$core/utils/Models";
import { prisma } from "$core/utils/Prisma";
import { checkUser, getUser, isPremium, updateUser } from "$core/utils/User";
import { ask } from "$resources/messages.json";
import { ButtonBuilder } from "@discordjs/builders";
import { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandStringOption, TextChannel } from "discord.js";
import { getLang } from "$core/utils/Message";
import Client from "$core/Client";
import Command from "$core/commands/Command";
import Logger from "$core/utils/Logger";
import dayjs from "dayjs";

export default class Ask extends Command {

  public readonly slashCommand = new SlashCommandBuilder()
    .setName("ask")
    .setDescription(ask.command.description["en-US"])
    .setDescriptionLocalizations({ fr: ask.command.description.fr })
    .addStringOption(new SlashCommandStringOption()
      .setName("content")
      .setDescription(ask.command.options.question["en-US"])
      .setDescriptionLocalizations({ fr: ask.command.options.question.fr })
      .setRequired(true))
    .addStringOption(new SlashCommandStringOption()
      .setName("context")
      .setDescription(ask.command.options.context["en-US"])
      .setDescriptionLocalizations({ fr: ask.command.options.context.fr })
      .addChoices(...AskContextOptions.map(c => ({ name: c.name, value: c.value, nameLocalizations: { fr: c.name_localizations.fr } }))))
    .addStringOption(new SlashCommandStringOption()
      .setName("language")
      .setDescription(ask.command.options.lang["en-US"])
      .setDescriptionLocalizations({ fr: ask.command.options.lang.fr })
      .addChoices(...Locales.map(l => ({ name: l.name, value: l.value }))))
    .setDMPermission(false);

  public async execute(command: ChatInputCommandInteraction): Promise<void> {
    await command.deferReply({ ephemeral: true });
    const askedAt = dayjs().toDate();
    await checkUser(command.user.id);
    const user = await getUser(command.user.id);
    const isPremiumUser = isPremium(user);

    if (!isPremiumUser) {
      if ((await getUser(command.user.id)).askUsage == 0) {
        command.editReply({ embeds: [simpleEmbed(ask.errors.trial[command.locale === "fr" ? "fr" : "en-US"], "error", { f: command.user })] });
        return;
      }
    }

    const question = command.options.getString("content", true);
    const context = command.options.getString("context", false);
    const language = command.options.getString("language", false);
    const finalQuestion = buildQuestion(question, context ?? "default", language ?? command.locale);

    const response = await Client.instance.openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      max_tokens: 2000,
      temperature: 0.9,
      messages: [{ content: finalQuestion, name: "User", role: "user" }]
    });

    const text = response.data.choices[0].message?.content ?? "I don't know what to say...";

    const embed = simpleEmbed(text, "normal", {
      text: command.user.username,
      timestamp: true,
      iconURL: command.user.displayAvatarURL()
    });

    const buttons: ButtonBuilder[] = [];
    if (!isPremiumUser) buttons.push(getUsageButton(user.askUsage - 1));
    buttons.push(getRevealButton(user.askUsage - 1));

    const channel = await command.client.channels.fetch(command.channelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    const collector = channel.createMessageComponentCollector({ time: 20000 });

    collector.on("collect", async i => {
      if (!i.isButton()) return;
      if (i.customId.startsWith("reveal")) {
        if (isPremiumUser) {
          await i.update({ embeds: [embed], components: [] });
          channel.send({ embeds: [embed.data], components: [] });
          return;
        }

        const usageRemaining: number = parseInt(i.customId.split("_")[1]);
        await i.update({ components: [{ type: 1, components: [getUsageButton(usageRemaining)] }] });
        await channel.send({ embeds: [embed.data], components: [{ type: 1, components: [getUsageButton(usageRemaining)] }] });
      }
    });

    if (!isPremiumUser) {
      collector.on("end", async() => {
        await command.editReply({ components: [{ type: 1, components: [getUsageButton(user.askUsage)] }] });
      });
    }

    await command.editReply({ embeds: [embed], components: [{ type: 1, components: buttons }] }).then(async() => {
      Logger.request(finalQuestion);

      await prisma.requests.create({
        data: {
          userId: command.user.id,
          guildName: command.guild?.name ?? "DM",
          channelName: channel.name ?? "DM",
          question: question,
          answer: Buffer.from(text).toString("base64"),
          answeredAt: dayjs().toDate(),
          askedAt: askedAt,
          timestamp: dayjs().unix().toString(),
          options: {
            context: context ?? "default",
            language: language ?? command.locale
          }
        }
      });

      updateUser(command.user.id, { lastAsked: dayjs().unix().toString(), askUsage: user.askUsage - 1 });

      if (!isPremiumUser) {
        if (text !== "I don't know what to say...") {
          await updateUser(command.user.id, { askUsage: user.askUsage - 1 });
        }
      }
    }).catch(async() => {
      await command.editReply({ embeds: [simpleEmbed(ask.errors.error[command.locale === "fr" ? "fr" : "en-US"], "error", { f: command.user })] });
    });
  }

}