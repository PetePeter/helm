// Native Helm CLI hook shim — the same forward as src/config/hooks/helm-hook-shim.py,
// without Python's ~150 ms start-up on every hook (two per tool call).
//
//	helm-hook.exe <cli> <event>   (hook JSON on stdin, Helm's reply on stdout)
//
// FAIL OPEN IS MANDATORY: every path exits 0 and prints nothing on failure.
// Exit code 2 would DENY the tool call. No HELM_SESSION_ID means a CLI Helm did
// not spawn: do nothing at all. The status line stays on the Python shim.
package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	defer func() { recover(); os.Exit(0) }()
	sid, url, tok := os.Getenv("HELM_SESSION_ID"), os.Getenv("HELM_HOOK_URL"), os.Getenv("HELM_MCP_TOKEN")
	if sid == "" || url == "" || tok == "" || len(os.Args) < 3 {
		return
	}
	in, err := io.ReadAll(os.Stdin)
	payload := bytes.TrimSpace(in)
	// Helm validates the JSON; an object is all the shim checks for.
	if err != nil || len(payload) == 0 || payload[0] != '{' {
		return
	}
	body := append([]byte(`{"cli":"`+os.Args[1]+`","event":"`+os.Args[2]+`","payload":`), payload...)
	body = append(body, '}')
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("x-helm-session-id", sid)
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if len(bytes.TrimSpace(out)) > 0 {
		os.Stdout.Write(out)
	}
}
