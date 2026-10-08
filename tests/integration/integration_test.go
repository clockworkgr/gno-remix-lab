// Package integration runs Remix Lab scenarios against a real in-memory
// gno.land node using the toolchain's testscript harness. Each script gets
// the repository's gno/ tree linked at $WORK/gno so `loadpkg` can add the
// Remix Lab /p/ packages to genesis, while app realms are deployed with a
// real MsgAddPackage from a test key.
package integration

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gnolang/gno/gno.land/pkg/integration"
	gno_integration "github.com/gnolang/gno/gnovm/pkg/integration"
	"github.com/rogpeppe/go-internal/testscript"
)

func TestScenarios(t *testing.T) {
	repoGno, err := filepath.Abs("../../gno")
	if err != nil {
		t.Fatal(err)
	}

	p := gno_integration.NewTestingParams(t, "testdata")
	if err := integration.SetupGnolandTestscript(t, &p); err != nil {
		t.Fatal(err)
	}
	p.Cmds["sleep"] = cmdSleep
	p.Cmds["stageruntime"] = cmdStageRuntime
	p.Cmds["capture"] = cmdCapture
	p.Cmds["rpcfixture"] = cmdRPCFixture
	p.Cmds["abcifixture"] = cmdABCIFixture

	inner := p.Setup
	p.Setup = func(env *testscript.Env) error {
		if err := os.Symlink(repoGno, filepath.Join(env.WorkDir, "gno")); err != nil {
			return err
		}
		if inner != nil {
			return inner(env)
		}
		return nil
	}
	testscript.Run(t, p)
}

// cmdSleep waits for a duration, e.g. `sleep 62s`, so scenarios can cross
// block-time deadlines on the live node.
func cmdSleep(ts *testscript.TestScript, neg bool, args []string) {
	if neg || len(args) != 1 {
		ts.Fatalf("usage: sleep <duration>")
	}
	d, err := time.ParseDuration(args[0])
	if err != nil {
		ts.Fatalf("sleep: %v", err)
	}
	time.Sleep(d)
}

// cmdStageRuntime copies the files that belong on chain (gnomod.toml and
// non-test .gno files) from a package directory into a new directory, e.g.
// `stageruntime $WORK/gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/clubpoll $WORK/deploy/clubpoll`.
// `gnokey maketx addpkg -pkgdir` uploads every .gno file, tests included, so
// deployments must start from a staged runtime bundle.
func cmdStageRuntime(ts *testscript.TestScript, neg bool, args []string) {
	if neg || len(args) != 2 {
		ts.Fatalf("usage: stageruntime <src-dir> <dst-dir>")
	}
	src, dst := ts.MkAbs(args[0]), ts.MkAbs(args[1])
	entries, err := os.ReadDir(src)
	ts.Check(err)
	ts.Check(os.MkdirAll(dst, 0o755))
	for _, e := range entries {
		name := e.Name()
		runtime := name == "gnomod.toml" ||
			strings.HasSuffix(name, ".gno") && !strings.HasSuffix(name, "_test.gno") && !strings.HasSuffix(name, "_filetest.gno")
		if e.IsDir() || !runtime {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, name))
		ts.Check(err)
		ts.Check(os.WriteFile(filepath.Join(dst, name), data, 0o644))
	}
}

// cmdCapture sets an environment variable from the first submatch of a
// regular expression applied to the previous command's stdout, e.g.
// `capture VOTE_HASH 'TX HASH:\s+(\S+)'`.
func cmdCapture(ts *testscript.TestScript, neg bool, args []string) {
	if neg || len(args) != 2 {
		ts.Fatalf("usage: capture <var> <regexp>")
	}
	m := regexp.MustCompile(args[1]).FindStringSubmatch(ts.ReadFile("stdout"))
	if len(m) < 2 {
		ts.Fatalf("capture: no match for %q", args[1])
	}
	ts.Setenv(args[0], m[1])
}

// cmdRPCFixture sends one JSON-RPC request to the running node and prints
// the raw response body to stdout. With REMIX_FIXTURE_DIR set, it also saves
// {"request", "response"} as <dir>/<name>.json for the TypeScript chain
// adapter's tests:
//
//	rpcfixture <name> <method> <params-json>
func cmdRPCFixture(ts *testscript.TestScript, neg bool, args []string) {
	if neg || len(args) != 3 {
		ts.Fatalf("usage: rpcfixture <name> <method> <params-json>")
	}
	name, method, params := args[0], args[1], json.RawMessage(args[2])
	if !json.Valid(params) {
		ts.Fatalf("rpcfixture: params are not JSON: %s", params)
	}
	rpcFixture(ts, name, method, params)
}

// cmdABCIFixture is rpcfixture for abci_query with the query data given as
// text; JSON-RPC carries it base64-encoded:
//
//	abcifixture <name> <path> <data>
func cmdABCIFixture(ts *testscript.TestScript, neg bool, args []string) {
	if neg || len(args) != 3 {
		ts.Fatalf("usage: abcifixture <name> <path> <data>")
	}
	params, err := json.Marshal(map[string]any{
		"path":   args[1],
		"data":   base64.StdEncoding.EncodeToString([]byte(args[2])),
		"height": "0",
		"prove":  false,
	})
	ts.Check(err)
	rpcFixture(ts, args[0], "abci_query", params)
}

func rpcFixture(ts *testscript.TestScript, name, method string, params json.RawMessage) {
	req, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	ts.Check(err)
	addr := ts.Getenv("RPC_ADDR")
	if !strings.Contains(addr, "://") {
		addr = "http://" + addr
	}
	addr = strings.Replace(addr, "tcp://", "http://", 1)
	resp, err := http.Post(addr, "application/json", bytes.NewReader(req))
	ts.Check(err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	ts.Check(err)
	fmt.Fprintf(ts.Stdout(), "%s\n", body)

	dir := os.Getenv("REMIX_FIXTURE_DIR")
	if dir == "" {
		return
	}
	// Fixtures are committed: keep this machine's name out of them.
	if host, err := os.Hostname(); err == nil && host != "" {
		body = bytes.ReplaceAll(body, []byte(host), []byte("fixture-host"))
	}
	var request, response any
	ts.Check(json.Unmarshal(req, &request))
	ts.Check(json.Unmarshal(body, &response))
	out, err := json.MarshalIndent(map[string]any{"request": request, "response": response}, "", "  ")
	ts.Check(err)
	ts.Check(os.MkdirAll(dir, 0o755))
	ts.Check(os.WriteFile(filepath.Join(dir, name+".json"), append(out, '\n'), 0o644))
}
