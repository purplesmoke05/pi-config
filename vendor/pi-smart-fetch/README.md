# pi-smart-fetch (vendored)

This directory vendors `pi-smart-fetch` 0.3.17 from upstream commit
`b01116124971de44f16a4477e34c06ba2ab1d0bf` with a local security patch.

Vendor note: the upstream `wreq-js` browser-fingerprint transport is removed.
Requests use Node's standard `http`/`https` clients, resolve every DNS answer,
reject non-public addresses, and pin the selected public address for each hop.
Connections never reuse a process-global socket, and Azure WireServer is denied
explicitly. Redirects are checked manually (maximum five), credentials stay
stripped after cross-origin hops, and one deadline covers DNS, redirects, body
reading, and extraction. Synchronous HTML parsing is rejected above 50,000 elements
or 256 nesting levels, and Defuddle runs in a terminable worker so its CPU work cannot
outlive that deadline. Textual responses are capped at 5 MiB, and files at 50 MiB.
Returned text is additionally capped at 200,000 characters and request timeouts
at 60 seconds, regardless of project settings.
Downloads always use the private agent cache directory with mode 0700/0600;
exclusive-name retries preserve the original response body.

The extension registers `web_fetch` and `batch_web_fetch`. Defuddle is run with
`useAsync: false`, so extraction cannot initiate additional network requests. Fetched
text also has terminal control characters removed before reaching Pi's renderer.
Batch calls accept at most 10 requests and run at most four concurrently.
