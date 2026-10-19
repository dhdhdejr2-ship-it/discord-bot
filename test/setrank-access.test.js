const assert = require("node:assert/strict");
const test = require("node:test");
const { getSetRankRoleIds, memberHasAnyRole } = require("../lib/setrank-access");

test("combines the existing moderator role with additional setrank roles", () => {
  assert.deepEqual(getSetRankRoleIds({
    MOD_ROLE_ID: "123456789012345678",
    SETRANK_ROLE_IDS: "1557558508428337185, 234567890123456789 1557558508428337185",
  }), ["123456789012345678", "1557558508428337185", "234567890123456789"]);
});

test("ignores invalid role ids", () => {
  assert.deepEqual(getSetRankRoleIds({ MOD_ROLE_ID: "bad", SETRANK_ROLE_IDS: " , 12x  " }), []);
});

test("authorizes an interaction member with an allowed role id array", () => {
  assert.equal(memberHasAnyRole({ roles: ["1557558508428337185"] }, ["1557558508428337185"]), true);
});

test("authorizes a guild member with an allowed cached role", () => {
  const member = { roles: { cache: new Map([["1557558508428337185", {}]]) } };
  assert.equal(memberHasAnyRole(member, ["1557558508428337185"]), true);
});

test("rejects members without a configured role", () => {
  assert.equal(memberHasAnyRole({ roles: ["999"] }, ["1557558508428337185"]), false);
  assert.equal(memberHasAnyRole({ roles: ["1557558508428337185"] }, []), false);
});
