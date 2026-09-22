# K8s Learning Project — orders-api

A small 2-service app (Node/Express API + Postgres) built specifically to
exercise the core Kubernetes objects hands-on, then load-test it so you
can watch the HPA react in real time.

## Architecture

```
                 ┌─────────────┐
  client ──────▶ │ orders-api  │ (2+ pods, HPA-managed)
                 │  Service    │
                 └──────┬──────┘
                        │ DNS: postgres:5432
                 ┌──────▼──────┐
                 │  postgres   │ (1 pod, PVC-backed)
                 │  Service    │
                 └─────────────┘
```

## Part 1 — Core concepts, mapped to the files

| File | K8s object | What it's for |
|---|---|---|
| `00-namespace.yaml` | Namespace | Logical isolation boundary for everything else |
| `01-configmap.yaml` | ConfigMap | Non-secret config, decoupled from the image |
| `02-secret.yaml` | Secret | Same idea, for sensitive values (base64, not encrypted by default) |
| `03-postgres-pvc.yaml` | PersistentVolumeClaim | Durable storage that survives pod restarts |
| `04-postgres-deployment.yaml` | Deployment | Declares desired pod state; the controller reconciles toward it |
| `05-postgres-service.yaml`, `07-api-service.yaml` | Service | Stable DNS name + load balancing over a set of pods |
| `06-api-deployment.yaml` | Deployment (+ probes) | Readiness (traffic gate) vs liveness (restart trigger) |
| `08-hpa.yaml` | HorizontalPodAutoscaler | Watches CPU %, adjusts replica count automatically |

The one mental model underlying all of it: **you declare desired state,
a controller's reconcile loop continuously pushes reality toward it.**
Every object above is just a different controller watching a different
piece of state. Deleting a pod doesn't "remove capacity" — the
Deployment's controller notices the mismatch (2 desired vs 1 actual) and
creates a replacement within seconds. That's worth doing once, on
purpose, just to watch it happen (Step 5 below).

## Part 2 — Run it locally

Requires: `kind`, `kubectl`, `docker`, `k6` (for load testing), and
optionally `k9s` for a live terminal view of the cluster.

**1. Create a local cluster**
```bash
kind create cluster --name k8s-learning
```

**2. Build the API image and load it into kind**

kind runs its own Docker-in-Docker-ish nodes — it can't pull an image
that's only on your host machine, so you load it explicitly instead of
pushing to a registry.
```bash
cd app
docker build -t orders-api:local .
kind load docker-image orders-api:local --name k8s-learning
cd ..
```

**3. Install metrics-server** (the HPA has nothing to read without it)
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# kind's metrics-server needs --kubelet-insecure-tls, patch it:
kubectl patch deployment metrics-server -n kube-system --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

**4. Apply everything, in order**
```bash
kubectl apply -f k8s/
```

**5. Watch it come up — and break it on purpose**
```bash
kubectl get pods -n k8s-learning -w
# once running, in another terminal, grab one pod name and delete it:
kubectl delete pod -n k8s-learning $(kubectl get pod -n k8s-learning -l app=orders-api -o jsonpath='{.items[0].metadata.name}')
# watch the first terminal — a replacement pod appears within seconds.
# This is the reconcile loop, not magic.
```

**6. Reach the API**
```bash
kubectl port-forward -n k8s-learning svc/orders-api 8080:80
curl http://localhost:8080/
curl -X POST http://localhost:8080/orders -H 'Content-Type: application/json' -d '{"item":"widget","qty":3}'
curl http://localhost:8080/orders
```

## Part 3 — Generate traffic and watch the HPA

This is the part that makes autoscaling click — you need to actually
*see* the reconcile loop respond to load, not just read about it.

**Terminal A — watch the HPA and pods live**
```bash
kubectl get hpa -n k8s-learning -w
# in another pane:
kubectl top pods -n k8s-learning
# or, nicer: k9s, then press ":hpa" and ":pods"
```

**Terminal B — run the load test** (keep the port-forward from step 6 running)
```bash
cd loadtest
k6 run -e BASE_URL=http://localhost:8080 load-test.js
```

What to watch for, in order:
1. `kubectl top pods` CPU numbers climb as k6 ramps up.
2. Once average CPU crosses 50% of the 100m request, the HPA's `TARGETS`
   column in Terminal A shows it, and `REPLICAS` starts climbing.
3. New pods appear in `kubectl get pods -w` — watch them go
   `Pending → ContainerCreating → Running`, then `readinessProbe`
   passing before they receive traffic.
4. After k6 ramps down, CPU drops, but the HPA won't scale down
   immediately — there's a default 5-minute stabilization window to
   avoid flapping. Worth just waiting it out once to feel that delay.

If you don't see any scaling, the two usual culprits: metrics-server
isn't reporting yet (`kubectl top pods` shows nothing for ~1 min after
install) or the load isn't sustained long enough — increase the k6
`target` or duration.

## Part 4 — Where this connects to the roadmap

- Once this works locally, Phase 2 adds an Ingress instead of
  port-forwarding.
- Phase 3 turns `k8s/*.yaml` into a Helm chart and has ArgoCD sync it —
  directly transferable to the ArgoCD/Argo Rollouts setup you're
  already doing on the event platform migration.
- Phase 4 swaps this CPU-based HPA for KEDA scaling on a custom metric
  (e.g., queue depth if you add a worker + Redis) — same idea, different
  scaling signal.
