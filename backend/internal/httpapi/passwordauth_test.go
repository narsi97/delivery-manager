package httpapi

import (
	"net/http"
	"testing"
)

// setPassword gives a user one, the way the owner would.
func setPassword(t *testing.T, admin *client, driverID, password string) {
	t.Helper()
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+driverID+"/password",
		map[string]any{"password": password}, http.StatusOK)
}

func TestADriverSignsInWithTheirNumberAndPassword(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")
	setPassword(t, admin, id, "milk2026")

	c := &client{t: t, server: server}
	body := c.mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000000001", "password": "milk2026"}, http.StatusOK)
	if str(body, "token") == "" {
		t.Fatal("signing in returned no token")
	}
	// The number is the username, so however it was typed it still works.
	c.mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "+91 90000 00001", "password": "milk2026"}, http.StatusOK)
}

// A wrong password and an unknown number answer identically, so this
// can't be used to find out who has an account.
func TestAWrongPasswordAndAnUnknownNumberLookTheSame(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")
	setPassword(t, admin, id, "milk2026")

	wrong := (&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000000001", "password": "wrong-one"}, http.StatusUnauthorized)
	unknown := (&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000009999", "password": "wrong-one"}, http.StatusUnauthorized)

	if str(wrong, "error") != str(unknown, "error") || str(wrong, "code") != str(unknown, "code") {
		t.Fatalf("the two answers differ: %q vs %q", str(wrong, "error"), str(unknown, "error"))
	}
}

// An account with no password set must never match — least of all an
// empty one.
func TestAnAccountWithNoPasswordCannotSignIn(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	makeDriver(t, admin, "Ravi", "+91 90000 00001")

	for _, attempt := range []string{"", "anything"} {
		(&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
			map[string]any{"phone": "9000000001", "password": attempt}, http.StatusUnauthorized)
	}
}

// Deactivating a driver locks them out of the password door too.
func TestADeactivatedDriverCannotSignIn(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")
	setPassword(t, admin, id, "milk2026")
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/active",
		map[string]any{"active": false}, http.StatusOK)

	(&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000000001", "password": "milk2026"}, http.StatusForbidden)
}

func TestChangingYourOwnPassword(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")
	setPassword(t, admin, id, "milk2026")

	signIn := func(password string, want int) *client {
		c := &client{t: t, server: server}
		body := c.mustDo(http.MethodPost, "/api/v1/auth/signin",
			map[string]any{"phone": "9000000001", "password": password}, want)
		c.token = str(body, "token")
		return c
	}

	driver := signIn("milk2026", http.StatusOK)

	// The current one is required, so an unlocked phone on a seat can't
	// be used to lock its owner out.
	driver.mustDo(http.MethodPost, "/api/v1/auth/password",
		map[string]any{"current_password": "not-it", "new_password": "curd2026"}, http.StatusUnauthorized)
	driver.mustDo(http.MethodPost, "/api/v1/auth/password",
		map[string]any{"current_password": "milk2026", "new_password": "short"}, http.StatusBadRequest)

	driver.mustDo(http.MethodPost, "/api/v1/auth/password",
		map[string]any{"current_password": "milk2026", "new_password": "curd2026"}, http.StatusOK)

	signIn("milk2026", http.StatusUnauthorized)
	signIn("curd2026", http.StatusOK)
}

// The owner can reset a driver who has forgotten theirs — there is no
// channel to send a reset link down.
func TestTheOwnerCanResetADriversPassword(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")
	setPassword(t, admin, id, "milk2026")
	setPassword(t, admin, id, "newone2026")

	(&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000000001", "password": "milk2026"}, http.StatusUnauthorized)
	(&client{t: t, server: server}).mustDo(http.MethodPost, "/api/v1/auth/signin",
		map[string]any{"phone": "9000000001", "password": "newone2026"}, http.StatusOK)
}

// One business's owner cannot set a password on another's driver.
func TestOnlyYourOwnDriversPasswordCanBeSet(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	other := secondBusinessAdminClient(t, server)
	theirs := makeDriver(t, other, "Theirs", "+91 90000 00077")

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+theirs+"/password",
		map[string]any{"password": "takeover2026"}, http.StatusNotFound)
}

// Too short is refused at the point it is set, not discovered at sign-in.
func TestAPasswordHasAMinimumLength(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	id := makeDriver(t, admin, "Ravi", "+91 90000 00001")

	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/password",
		map[string]any{"password": "abc"}, http.StatusBadRequest)
	admin.mustDo(http.MethodPost, "/api/v1/drivers/"+id+"/password",
		map[string]any{"password": ""}, http.StatusBadRequest)
}
