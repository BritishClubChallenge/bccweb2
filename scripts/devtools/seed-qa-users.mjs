// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
// DEV-ONLY: seeds 2 fixed QA users (admin, pilot) + 1 pilot record + supporting
// club/site/season fixtures into Azurite for the F3 brief-lifecycle manual QA.
// NOT for production. Hardcoded password "test1234!" + deterministic UUIDs.
import bcrypt from "bcryptjs";
import { createBlobServiceClient, preflightBlobReadAccess } from "../lib/storageClients.mjs";
const LOCAL_CONNECTION = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const connectionString = process.env.BLOB_CONNECTION_STRING ?? (process.env.BLOB_STORAGE_ACCOUNT_NAME ? undefined : LOCAL_CONNECTION);
const svc = createBlobServiceClient({ connectionString });
const pub = svc.getContainerClient("data"), priv = svc.getContainerClient("data-private");
await Promise.all([
  preflightBlobReadAccess({ container: pub, connectionString }),
  preflightBlobReadAccess({ container: priv, connectionString }),
]);
const put = async (c, p, o) => { const b = JSON.stringify(o, null, 2); await c.getBlockBlobClient(p).upload(b, Buffer.byteLength(b), { blobHTTPHeaders: { blobContentType: "application/json" } }); };
const A_ID = "11111111-1111-4111-8111-111111111111", P_ID = "22222222-2222-4222-8222-222222222222";
const PILOT_ID = "33333333-3333-4333-8333-333333333333", CLUB_ID = "44444444-4444-4444-8444-444444444444";
const SITE_ID = "55555555-5555-4555-8555-555555555555", YEAR = 2025;
const hash = await bcrypt.hash("test1234!", 4), now = new Date().toISOString();
await put(priv, `users/${A_ID}.json`, { id: A_ID, email: "qa-admin@example.test", roles: ["Admin"], pilotId: null, clubId: null, createdAt: now });
await put(priv, `auth/${A_ID}.json`, { passwordHash: hash, emailVerified: true, createdAt: now });
await put(priv, `users/${P_ID}.json`, { id: P_ID, email: "qa-pilot@example.test", roles: ["Pilot"], pilotId: PILOT_ID, clubId: CLUB_ID, createdAt: now });
await put(priv, `auth/${P_ID}.json`, { passwordHash: hash, emailVerified: true, createdAt: now });
await put(priv, "user-index.json", { "qa-admin@example.test": A_ID, "qa-pilot@example.test": P_ID });
await put(priv, `pilots/${PILOT_ID}.json`, { id: PILOT_ID, coachType: "None", pilotRating: "Pilot", wingClass: "EN B", person: { id: PILOT_ID + "-p", firstName: "QA", lastName: "Pilot", fullName: "QA Pilot" }, currentClub: { id: CLUB_ID, name: "QA Club" }, seasonClubs: [], userId: P_ID });
await put(pub, "pilots.json", [{ id: PILOT_ID, name: "QA Pilot", clubId: CLUB_ID, rating: "Pilot" }]);
await put(priv, `clubs/${CLUB_ID}.json`, { id: CLUB_ID, name: "QA Club", sites: [SITE_ID], teams: [] });
await put(pub, "clubs.json", [{ id: CLUB_ID, name: "QA Club" }]);
await put(priv, `sites/${SITE_ID}.json`, { id: SITE_ID, name: "QA Site", status: "Active", clubId: CLUB_ID });
await put(pub, "sites.json", [{ id: SITE_ID, name: "QA Site", status: "Active", clubId: CLUB_ID }]);
const season = { id: `season-${YEAR}`, year: YEAR, active: true, rounds: [], leagueTable: [] };
await put(priv, `seasons/${YEAR}.json`, season);
await put(pub, `seasons/${YEAR}.json`, season);
await put(pub, "seasons.json", [{ id: season.id, year: YEAR, active: true }]);
console.log(JSON.stringify({ adminUserId: A_ID, pilotUserId: P_ID, pilotId: PILOT_ID, clubId: CLUB_ID, siteId: SITE_ID, year: YEAR }, null, 2));
