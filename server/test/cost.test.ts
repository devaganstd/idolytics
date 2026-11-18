import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { INSERT_EVENT } from "../src/ingest";
import { reset } from "./helpers";

beforeEach(reset);

it("writes 2 D1 rows per stored event", async () => {
  const insert = (id: string) => env.DB.prepare(INSERT_EVENT)
    .bind("demo", id, "level_start", "d1", "s1", null, Date.now(), Date.now(), "1.0", "webgl", "os", "ID", "1", 1, null, null, null, '{"a":1}')
    .run();
  const first = await insert("e1");
  expect(first.meta.rows_written).toBe(2); // primary key b-tree + events_by_time; was 6 before migration 0002
  expect((await insert("e1")).meta.rows_written).toBe(0); // a replay writes nothing
});
