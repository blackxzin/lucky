import { describe, expect, test } from "vitest";
import { createAlerts, type AlertSources } from "../src/hub/alerts.js";

const sources = (state: { disk?: number; battery?: { percent: number; charging: boolean }; memory?: number }): AlertSources => ({
  diskUsed: async () => state.disk,
  battery: async () => state.battery,
  memoryFree: async () => state.memory,
});

describe("alerts", () => {
  test("warns once when the disk fills and stays quiet while it stays full", async () => {
    const state = { disk: 0.5 };
    const alerts = createAlerts(sources(state));

    expect(await alerts.check()).toEqual([]);
    state.disk = 0.95;
    expect(await alerts.check()).toEqual(["Disco quase cheio: 95% usado."]);
    expect(await alerts.check()).toEqual([]);
  });

  test("warns again only after the problem cleared", async () => {
    const state = { disk: 0.95 };
    const alerts = createAlerts(sources(state));
    await alerts.check();

    state.disk = 0.91; // faixa do meio: ainda conta como o mesmo problema
    expect(await alerts.check()).toEqual([]);
    state.disk = 0.7;
    await alerts.check();
    state.disk = 0.96;
    expect(await alerts.check()).toHaveLength(1);
  });

  test("battery warns when low and not charging, never while charging", async () => {
    const state = { battery: { percent: 15, charging: true } };
    const alerts = createAlerts(sources(state));

    expect(await alerts.check()).toEqual([]);
    state.battery = { percent: 15, charging: false };
    expect(await alerts.check()).toEqual(["Bateria do PC em 15%. Liga o carregador."]);
  });

  test("a desktop without battery produces no battery alert", async () => {
    expect(await createAlerts(sources({ disk: 0.1 })).check()).toEqual([]);
  });

  test("memory alert reports what is left", async () => {
    expect(await createAlerts(sources({ memory: 0.05 })).check()).toEqual(["Memória no limite: só 5% livre."]);
  });

  test("a failing reading does not hide the other alerts", async () => {
    const broken: AlertSources = {
      diskUsed: async () => {
        throw new Error("EIO");
      },
      battery: async () => undefined,
      memoryFree: async () => 0.01,
    };

    expect(await createAlerts(broken).check()).toEqual(["Memória no limite: só 1% livre."]);
  });
});
