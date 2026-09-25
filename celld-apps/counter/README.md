# counter

A minimal [celld](https://celld.dev) app: a Durable Object counter and an R2
file store. It runs on the remote dev VM's celld, which keeps its state in
minio's `celld` bucket.

Turn celld on with `echo/scripts/remote-dev/init.sh` (answer `y` to "Run
celld?"), then `./up.sh --skip-setup`. With `./tunnel.sh` open, deploy from
`echo/scripts/remote-dev/`:

```sh
./celld-deploy.sh ../../../celld-apps/counter
```

The node picks the new version up within about five seconds:

```sh
curl localhost:8787/count?name=a          # {"n":1}
curl localhost:8787/count?name=a          # {"n":2}
curl -X PUT --data hello localhost:8787/files/greeting
curl localhost:8787/files/greeting        # hello
curl localhost:8787/files                 # [{"key":"greeting","size":5}]
```

The objects are visible in the minio console (http://localhost:9001, bucket
`celld`).
