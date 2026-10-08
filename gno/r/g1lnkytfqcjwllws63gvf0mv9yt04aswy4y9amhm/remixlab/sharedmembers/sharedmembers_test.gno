package sharedmembers

import (
	"strings"
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

var (
	owner   = testutils.TestAddress("owner")
	alice   = testutils.TestAddress("alice")
	mallory = testutils.TestAddress("mallory")
)

// Runs first: under gno test, init has no user deployer.
func TestUninitializedSnapshotFails(t *testing.T) {
	_, ok := Snapshot(core.RoleMember, 10)
	uassert.False(t, ok)
	uassert.Equal(t, 0, Size())
}

func TestReadInterface(cur realm, t *testing.T) {
	setup(owner)
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))

	uassert.Equal(t, int(core.RoleMember), int(RoleOf(alice)))
	uassert.Equal(t, int(core.RoleNone), int(RoleOf(mallory)))
	uassert.Equal(t, 2, Size())
	snap, ok := Snapshot(core.RoleMember, 10)
	uassert.True(t, ok)
	uassert.Equal(t, 2, len(snap))
	_, ok = Snapshot(core.RoleMember, 1)
	uassert.False(t, ok)
	uassert.True(t, strings.Contains(Render(""), "2 members"))
}

func TestMutationsRequireAuthority(cur realm, t *testing.T) {
	setup(owner)
	testing.SetRealm(testing.NewUserRealm(mallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.invite requires owner", func() {
		Invite(cross(cur), mallory, "owner")
	})
	// A consuming app realm acting under an owner-signed transaction is
	// still only itself.
	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/sharedpoll"))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.remove requires owner", func() {
		RemoveMember(cross(cur), owner)
	})
}

func TestReviewerCannotAdminister(cur realm, t *testing.T) {
	setup(owner)
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "reviewer")
	Invite(cross(cur), mallory, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))
	uassert.Equal(t, 1, len(Invites(0, 25)))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.set_role requires owner", func() {
		SetRole(cross(cur), alice, "owner")
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.remove requires owner", func() {
		RemoveMember(cross(cur), owner)
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.invite requires owner", func() {
		RevokeInvite(cross(cur), mallory)
	})
	Leave(cross(cur))
	uassert.Equal(t, int(core.RoleNone), int(RoleOf(alice)))
}
