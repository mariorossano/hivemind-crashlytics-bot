import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CrashlyticsBot } from '../src/runtime.ts';
import { saveArtifact } from '../src/artifacts.ts';

const source = process.env.HIVEMIND_TEST_SOURCE;
test(
  'external Crashlytics native tools configure, connect, follow and stop one real isolated monitor',
  { skip: !source, timeout: 30000 },
  async (t) => {
    const { Hive } = await import(pathToFileURL(path.join(source!, 'src/server/hive.ts')).href);
    const { createApp } = await import(pathToFileURL(path.join(source!, 'src/server/app.ts')).href);
    const { startServer } = await import(
      pathToFileURL(path.join(source!, 'src/server/serve.ts')).href
    );
    const { registerBotDefinition, saveProjectBotConfiguration } = await import(
      pathToFileURL(path.join(source!, 'src/server/bot-definitions.ts')).href
    );
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-native-crashlytics-'));
    const hive = new Hive(path.join(dir, 'hive', 'hive.db'));
    registerBotDefinition(
      hive.home,
      fileURLToPath(new URL('../hivemind-bot.json', import.meta.url)),
    );
    const core = startServer({ hive, port: 0, telegram: false });
    let profile: string | undefined;
    t.after(async () => {
      if (profile) {
        const monitor = new CrashlyticsBot(profile);
        try {
          monitor.desired(false);
          for (let i = 0; i < 150 && monitor.isRunning(); i++) await delay(50);
          assert.equal(
            monitor.isRunning(),
            false,
            'owned test monitor must stop before removing its profile',
          );
        } finally {
          monitor.close();
        }
      }
      await core.shutdown();
      hive.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${await core.ready}`,
      app = createApp(hive);
    const human = hive.identity.getAgent('human');
    const project = hive.projects.createProject(human, {
      name: 'Crashlytics fixture',
      slug: 'crashlytics-fixture',
    });
    const brain = hive.identity.join({ role: 'brain', project: project.slug });
    const channel = hive.channels.createChannel(human, {
      name: 'MR',
      type: 'private',
      project: project.slug,
      memberNames: [brain.agent.name],
    });
    const saved = await saveProjectBotConfiguration(
      hive.home,
      project,
      origin,
      'hivemind-crashlytics',
      {
        enabled: true,
        expectedRevision: 0,
        values: {},
      },
    );
    profile = saved.home;
    const setup = await app.request(`${origin}/api/ui/projects/${project.id}/bots/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Crashlytics', definitionId: 'hivemind-crashlytics' }),
    });
    assert.equal(setup.status, 201);
    const created = (await setup.json()) as any;
    assert.equal(created.connected, true);
    const catalog = await app.request(`${origin}/api/agent/bot-tools`, {
      headers: { authorization: `Bearer ${brain.token}` },
    });
    assert.equal(catalog.status, 200);
    const tools = ((await catalog.json()) as any).bots.find(
      (bot: any) => bot.id === created.bot.id,
    ).tools;
    const ranking = tools.find((tool: any) => tool.name === 'top_issues');
    assert.equal(ranking.effect, 'read');
    assert.equal(ranking.parameters.fields.find((field: any) => field.key === 'limit').maximum, 10);
    // Exercise real core argument admission without contacting Firebase.
    const invalidRanking = await app.request(`${origin}/api/agent/bots/${created.bot.id}/tools`, {
      method: 'POST',
      headers: { authorization: `Bearer ${brain.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'top_issues',
        arguments: { url: 'https://example.invalid', limit: 11 },
      }),
    });
    assert.equal(invalidRanking.status, 400);
    const call = async (tool: string, args = {}) => {
      const response = await app.request(`${origin}/api/agent/bots/${created.bot.id}/tools`, {
        method: 'POST',
        headers: { authorization: `Bearer ${brain.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args }),
      });
      const body = (await response.json()) as any;
      let diagnostic = `${tool}: ${JSON.stringify(body)}`;
      if (response.status !== 200 && tool === 'start' && profile) {
        // This profile contains synthetic fixtures only. Preserve the daemon's
        // startup evidence before test cleanup removes it; the API stays redacted.
        try {
          diagnostic += `\nFixture monitor log:\n${readFileSync(path.join(profile, 'monitor.log'), 'utf8')}`;
        } catch {
          /* startup may have failed before opening its log */
        }
      }
      assert.equal(response.status, 200, diagnostic);
      return body.result;
    };
    assert.equal((await call('status')).monitorRunning, false);
    const invalidSource = await call('top_issues', {
      url: 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues?tag=regressed',
    });
    assert.equal(invalidSource.ok, false);
    assert.equal(invalidSource.error.code, 'INVALID_SOURCE');
    assert.match(invalidSource.error.message, /tag=all/);
    assert.equal(invalidSource.issues, undefined);
    const followed = await call('follow', {
      url: 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues',
      channel: channel.id,
    });
    assert.ok(followed.id);
    assert.ok(hive.channels.getChannel(channel.id).memberIds.includes(created.bot.id));
    assert.equal((await call('status')).monitorRunning, false);
    const details = await call('status', { section: 'subscriptions' });
    assert.equal(details.total, 1);
    // Real core ingress, upload, deduplication and private channel visibility;
    // only the upstream Firebase reader is substituted with invented diagnostics.
    let reads = 0;
    const fixtureText = 'InventedCrash.swift:42\nSynthetic diagnostic; no real application data.';
    const artifact = saveArtifact(profile!, 'synthetic-stack.txt', fixtureText);
    const monitor = new CrashlyticsBot(profile!, async () => {
      reads++;
      return {
        stdout: JSON.stringify({
          observations: [
            {
              key: 'issue:fixture',
              value: { state: 'OPEN' },
              body: 'Synthetic crash observation',
              url: 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues/fixture',
              samples: [{ variant: 'variant1', artifact }],
            },
          ],
          warnings: ['Synthetic sample warning'],
        }),
      };
    });
    try {
      assert.equal((await monitor.cycle())[0].queued, 1);
      assert.equal((await monitor.cycle())[0].queued, 0);
      assert.equal(reads, 2);
      assert.equal(
        monitor.db.prepare("SELECT COUNT(*) n FROM events WHERE state='sent'").get()!.n,
        1,
      );
    } finally {
      monitor.close();
    }
    const messagesResponse = await app.request(
      `${origin}/api/agent/channels/${channel.id}/messages`,
      { headers: { authorization: `Bearer ${brain.token}` } },
    );
    assert.equal(messagesResponse.status, 200);
    const messages = ((await messagesResponse.json()) as any).messages.filter(
      (message: any) => message.authorId === created.bot.id,
    );
    assert.equal(messages.length, 1);
    const stackMessage = messages.find((message: any) => message.attachments.length);
    assert.equal(stackMessage.attachments.length, 1);
    const download = await app.request(
      `${origin}/api/agent/files/${stackMessage.attachments[0].id}`,
      { headers: { authorization: `Bearer ${brain.token}` } },
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), fixtureText);
    const stranger = hive.identity.join({
      role: 'worker',
      project: project.slug,
      focus: 'fixture',
      seniority: 'senior',
    });
    const denied = await app.request(
      `${origin}/api/agent/files/${stackMessage.attachments[0].id}`,
      {
        headers: { authorization: `Bearer ${stranger.token}` },
      },
    );
    assert.equal(denied.status, 403);
    const diagnostics = await call('status', { section: 'subscriptions' });
    assert.match(diagnostics.rows[0].warnings, /Synthetic sample warning/);
    assert.equal((await call('retry', { id: followed.id })).requeued, 0);
    assert.equal((await call('stop')).monitorRunning, false);
    assert.equal((await call('unfollow', { id: followed.id })).state, 'stopped');
    // All sources are disabled before starting: no provider calls or model usage.
    assert.equal((await call('start')).monitorRunning, true);
    assert.equal((await call('stop')).stopRequested, true);
    let state = await call('status');
    for (let i = 0; i < 30 && state.monitorRunning; i++) {
      await delay(50);
      state = await call('status');
    }
    assert.equal(state.monitorRunning, false);
    assert.equal(
      hive.identity.listAgents(human).filter((agent: { role: string }) => agent.role === 'bot')
        .length,
      1,
    );
  },
);
