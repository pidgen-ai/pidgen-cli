import { describe, expect, it } from "vitest";
import {
  isMintedWorkerId,
  liveWorkersNamed,
  selectWorker,
  workerLabel,
  workerName,
} from "../../src/core/worker-identity.js";
import type { WorkerList } from "../../src/core/worker-enrollments.js";

// AC-e08e6c67ad9b: how this machine's worker is found in the Account's list, rule by rule.

const MAD_MAX_ID = "wkr_examplexxxxxxxxxxxxxxxxxx";
const OTHER_ID = "wkr_otherxxxxxxxxxxxxxxxxxxxx";
const INSTALL_ID = "0123456789abcdef0123456789abcdef";
const HOST_NAME = "dev-laptop";

type Worker = WorkerList["workers"][number];

function worker(hostId: string, overrides: Partial<Worker> = {}): Worker {
  return {
    host_id: hostId,
    display_name: null,
    revoked_at: null,
    created_at: "2026-10-20T08:00:00Z",
    install_id: null,
    connected: true,
    ...overrides,
  } as Worker;
}

function list(workers: Worker[]): WorkerList {
  return { service_protocol: "1.0", accepted_protocols: ["1.0"], workers } as WorkerList;
}

const MAD_MAX = worker(MAD_MAX_ID, { display_name: "Mad-Max", install_id: INSTALL_ID });
const LEGACY = worker(HOST_NAME, { display_name: null, created_at: "2026-09-01T08:00:00Z" });

describe("selectWorker", () => {
  it("--host matches a host_id exactly", () => {
    const selected = selectWorker(list([MAD_MAX, LEGACY]), {
      option: MAD_MAX_ID,
      homeId: null,
      installId: null,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: MAD_MAX_ID, selected_by: "option" });
  });

  it("--host matches a display_name case-insensitively among unrevoked workers", () => {
    const revoked = worker(OTHER_ID, {
      display_name: "mad-max",
      revoked_at: "2026-10-19T08:00:00Z",
    });
    const selected = selectWorker(list([revoked, MAD_MAX]), {
      option: "MAD-max",
      homeId: null,
      installId: null,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: MAD_MAX_ID, selected_by: "option" });
  });

  it("--host that matches nothing is looked for as given", () => {
    const selected = selectWorker(list([MAD_MAX]), {
      option: "nobody",
      homeId: MAD_MAX_ID,
      installId: INSTALL_ID,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: "nobody", selected_by: "option" });
  });

  it("finds Mad-Max on dev-laptop by the id worker.env names (worker_home)", () => {
    const selected = selectWorker(list([LEGACY, MAD_MAX]), {
      homeId: MAD_MAX_ID,
      installId: INSTALL_ID,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: MAD_MAX_ID, selected_by: "worker_home" });
  });

  it("without a worker home credential, this install's newest worker by install_id", () => {
    const older = worker(OTHER_ID, {
      display_name: "Mad-Max-old",
      install_id: INSTALL_ID,
      created_at: "2026-10-01T08:00:00Z",
    });
    const selected = selectWorker(list([older, MAD_MAX, LEGACY]), {
      homeId: null,
      installId: INSTALL_ID,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: MAD_MAX_ID, selected_by: "install_id" });
  });

  it("an install id the list does not name falls through to the host name", () => {
    const selected = selectWorker(list([MAD_MAX, LEGACY]), {
      homeId: null,
      installId: "f".repeat(32),
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: HOST_NAME, selected_by: "host_name" });
  });

  it("for a worker enrolled before minted ids, the one whose host_id is this host's name", () => {
    const selected = selectWorker(list([LEGACY]), {
      homeId: null,
      installId: null,
      hostName: HOST_NAME,
    });
    expect(selected).toEqual({ host_id: HOST_NAME, selected_by: "host_name" });
  });
});

describe("names", () => {
  it("workerName is display_name, else host_id for a worker enrolled before names", () => {
    expect(workerName(MAD_MAX)).toBe("Mad-Max");
    expect(workerName(LEGACY)).toBe(HOST_NAME);
  });

  it("workerLabel shows a name with its id, and an id alone once", () => {
    expect(workerLabel(MAD_MAX_ID, "Mad-Max")).toBe(`Mad-Max (${MAD_MAX_ID})`);
    expect(workerLabel(HOST_NAME, null)).toBe(HOST_NAME);
    expect(workerLabel(HOST_NAME, HOST_NAME)).toBe(HOST_NAME);
    expect(workerLabel(null, "Mad-Max")).toBe("Mad-Max");
  });

  it("liveWorkersNamed compares display_name case-insensitively, host_id only when it is null", () => {
    const named = worker(OTHER_ID, { display_name: HOST_NAME.toLowerCase() });
    const workers = list([MAD_MAX, LEGACY, named]);
    expect(liveWorkersNamed(workers, "mad-MAX").map((w) => w.host_id)).toEqual([MAD_MAX_ID]);
    expect(liveWorkersNamed(workers, MAD_MAX_ID)).toEqual([]);
    expect(liveWorkersNamed(workers, HOST_NAME).map((w) => w.host_id)).toEqual([
      HOST_NAME,
      OTHER_ID,
    ]);
  });

  it("isMintedWorkerId knows a minted id", () => {
    expect(isMintedWorkerId("wkr_vyemfavnwd4fa7v3uzpr4hq6ia")).toBe(true);
    expect(isMintedWorkerId("Mad-Max")).toBe(false);
    expect(isMintedWorkerId("wkr_short")).toBe(false);
  });
});
