# Backend Deployment Flow (MERN → AWS ECS)

> This mirrors `flow_frontend.md`. We **reuse** the existing cluster (`blog-master`) and the existing OIDC provider + role (`github-actions-deploy-role`). Everything else — ECR repo, target group, ALB, security groups, task definition, service — is created fresh for the backend.
>
> **Key difference from the frontend:** the frontend's only env (the backend URL) is *public* and baked in at **build time**. The backend's env (`MONGODB_URL`, `TOKEN`, `FRONTEND_URL`, `NODE_ENV`, `PORT`) are **secrets** and must be injected at **runtime** via the ECS task definition — never committed to git or baked into the image.

## 1. Pre-checks

1. Make sure `.gitignore` ignores `.env` (it does) — secrets must never reach the repo.
2. Make sure `.dockerignore` ignores `.env` (it does) — so the image has no secrets baked in.
3. Locally run the backend using `yarn` or `npm` (`npm start`).
4. Dockerize the backend & run locally with the env passed at runtime.

> The backend runs on **port 3000** (`EXPOSE 3000` in the Dockerfile, `PORT` in `.env`) and exposes a health endpoint at **`/health`**.

## 2. Docker Commands

### Build the image

```bash
docker build -t blog-backend:latest .
```

### Run the backend container

> **Note:** `.env` is ignored in the Docker image, so pass it at **run time** via `--env-file`.

```bash
docker run -d --name blog-backend -p 3000:3000 --env-file .env blog-backend:latest
docker run -it --name blog-backend -p 3000:3000 --env-file .env blog-backend:latest
```

Verify it is healthy:

```bash
curl http://localhost:3000/health
# { "status": "OK", "message": "Server is running and healthy", ... }
```

### Stop & delete a container

```bash
docker stop blog-backend
docker rm blog-backend
```

> **Note:** `FRONTEND_URL` must point at the deployed frontend (used by CORS). `MONGODB_URL` points at your MongoDB Atlas cluster.

## 3. GitHub Action — Checkout Repo

Check out the repo & verify in GitHub.

```yaml
name: Deploy Backend to Production ECS

on:
  push:
    branches:
      - master

  workflow_dispatch:
    inputs:
      image_tag:
        description: Image tag used to deploy
        required: true
        default: latest

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v3
```

## 4. Create ECR in AWS

- Go to `ECR`.
- Check the selected region in the top-right corner.
  - `AWS_REGION: ap-south-1`
  - `ECR_REPOSITORY: blog-mern-backend`
- Image Tag — keep it default.
- Encryption — keep it default.
- Image Scanning setting — keep it default.

## 5. OIDC Identity Provider — REUSE existing

We already created the OIDC identity provider for the frontend. **No need to create it again.** It is shared account-wide.

- `IAM -> Identity Providers`
  - **Provider URL:** `https://token.actions.githubusercontent.com`
  - **Audience:** `sts.amazonaws.com`

> If it does not exist yet, follow step 5 of `flow_frontend.md`.

## 6. OIDC Role — REUSE existing

We already created `github-actions-deploy-role` for the frontend. **We reuse the same role** for the backend.

- Role: `github-actions-deploy-role`
- ARN: `arn:aws:iam::129494056630:role/github-actions-deploy-role`
- Existing permissions:
  - `AmazonEC2ContainerRegistryPowerUser` (login / push / pull ECR)
  - `AmazonECS_FullAccess` (ECS + task definitions — added at the end of the frontend flow)

> Since this role already has ECR + ECS access, no new permission changes are required for the backend.
>
> ⚠️ The role's trust policy restricts which repo can assume it. If the backend lives in a **different GitHub repository** than the frontend, edit the role's trust relationship to also allow the backend repo's `sub` (e.g. `repo:anuragaffection/blog_mern_backend:*`), or use a wildcard across both repos.

## 7. GitHub Action — Build & Push Image to ECR

```yaml
name: Deploy Backend to Production ECS

on:
  push:
    branches:
      - master

  workflow_dispatch:
    inputs:
      image_tag:
        description: Image tag used to deploy
        required: true
        default: latest

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: blog-mern-backend
  AWS_DEPLOY_ROLE_ARN: arn:aws:iam::129494056630:role/github-actions-deploy-role

permissions:
  contents: read
  id-token: write # required for requesting the OIDC JWT to authenticate with AWS

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v3

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image to Amazon ECR
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          # On manual runs use the provided tag, otherwise use the commit SHA
          IMAGE_TAG: ${{ github.event.inputs.image_tag || github.sha }}
        run: |
          docker build \
            -t "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" \
            -t "$REGISTRY/$ECR_REPOSITORY:latest" \
            .
          docker push "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
          docker push "$REGISTRY/$ECR_REPOSITORY:latest"
          echo "Pushed $REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
```

## 8. Verify the Image in ECR

- Go to `ECR`.
- You should see the image tags `latest` & the GitHub commit SHA.

**Optimizations:**

- Shorten the GitHub commit SHA to the first seven characters.
- **Security:** Move the deploy role ARN to GitHub Secrets.

> **Note:** Since the build happens in GitHub Actions and `.env` is git/docker-ignored, the image has **no secrets** baked in. All backend env is injected at runtime by ECS (see step 9 & 11).

## 9. Backend Environment — Inject at Runtime (NOT committed)

Unlike the frontend (whose public URL is baked in at build time), the backend env is **secret** and is injected at runtime through the **ECS task definition**. Two options:

### Option A — Plain `environment` in the task definition (simplest)

Put the key/value pairs directly in the task definition's `environment` array. Fast to set up, but the values are visible to anyone who can read the task definition.

### Option B — `secrets` via AWS Secrets Manager / SSM (recommended)

- Store each secret in **AWS Secrets Manager** (or **SSM Parameter Store**).
- Reference them in the task definition's `secrets` array (`valueFrom: <secret-arn>`).
- Grant the **task execution role** (`ecsTaskExecutionRole`) permission to read those secrets (`secretsmanager:GetSecretValue` / `ssm:GetParameters`).

The env keys the backend needs (`.env.example`):

| Key            | Notes                                              |
| -------------- | -------------------------------------------------- |
| `MONGODB_URL`  | MongoDB Atlas connection string — **secret**       |
| `TOKEN`        | JWT signing secret — **secret**                    |
| `FRONTEND_URL` | Deployed frontend origin (CORS allow-list)         |
| `NODE_ENV`     | `production`                                        |
| `PORT`         | `3000` (must match the container port)             |

> This doc uses **Option A** in the task-definition JSON below for clarity. For production, migrate `MONGODB_URL` and `TOKEN` to Option B.

### Going for option B 
- go the aws secret manager
- check our regsion - it must `ap-south-1` same as our ecs & load balancers 
- Secret type : other type of secret
- put the value in key value in a single secret - `master/blog/backend`
- to update or edit secret manager - `Retrieve secret value -> edit`
- after editing the secret - `re deploy the services` 



Add individually
Add environment variables using plain text values or secrets from AWS Secrets Manager or Parameter Store.

This means ECS will inject these as environment variables into your container
FRONTEND_URL=<value from Secrets Manager> <arn:aws:secretsmanager:ap-south-1:129494056630:secret:master/blog/backend-VxzXt5:FRONTEND_URL::>
MONGODB_URL=<value from Secrets Manager> <arn:aws:secretsmanager:ap-south-1:129494056630:secret:master/blog/backend-VxzXt5:MONGODB_URL::>
NODE_ENV=<value from Secrets Manager> <arn:aws:secretsmanager:ap-south-1:129494056630:secret:master/blog/backend-VxzXt5:NODE_ENV::>
PORT=<value from Secrets Manager> <arn:aws:secretsmanager:ap-south-1:129494056630:secret:master/blog/backend-VxzXt5:PORT::>
TOKEN=<value from Secrets Manager> <arn:aws:secretsmanager:ap-south-1:129494056630:secret:master/blog/backend-VxzXt5:TOKEN::>

Node.js application you can access them normally:
process.env.FRONTEND_URL
process.env.MONGODB_URL
process.env.NODE_ENV
process.env.PORT
process.env.TOKEN

## 10. Set Up ECS — REUSE existing cluster

The cluster already exists from the frontend. **Do not create a new one.**

- Cluster: `blog-master` (Fargate)

## 11. Create Task Definition for Backend

- **Task Definition family name:** `blog-backend-td`

### Infrastructure requirements

- **Launch Type:** `Fargate`
- **Task Size:** CPU `0.5 vCPU`, Memory `1 GB`
- **Task Role:** `-` (leave empty)
- **Task Execution role:** `ecsTaskExecutionRole` (the default role created during the frontend flow; reuse it — and if using Option B secrets, attach the read permission to it)

### Container 1

- **Name:** `blog-backend`
- **Image URI:** `129494056630.dkr.ecr.ap-south-1.amazonaws.com/blog-mern-backend:<tag>`
- **Container port:** `3000` (same as `EXPOSE` in the Dockerfile)
- **Protocol:** `TCP`
- **Port name:** `blog-backend-http`
- **App protocol:** `http`

### Environment variables (Option A)

Add each key from step 9 under the container's **Environment variables** section.

### Resource Allocation

- **CPU:** `0.5 vCPU`
- **Memory:** `1 GB`


### Attaching more permission to the task execution role

What should be attached?

For a quick test, attach AWS-managed policy:

SecretsManagerReadWrite

to:

ecsTaskExecutionRole

IAM → Roles → ecsTaskExecutionRole → Add Permissions

This is broader than needed, but good for debugging.

## 12. Task Definition JSON

After the first create, you can revise it. Note the `environment` array (Option A) — for production move `MONGODB_URL` / `TOKEN` into a `secrets` array (Option B).

```json
{
    "taskDefinitionArn": "arn:aws:ecs:ap-south-1:129494056630:task-definition/blog-backend-td:2",
    "containerDefinitions": [
        {
            "name": "blog-backend",
            "image": "129494056630.dkr.ecr.ap-south-1.amazonaws.com/blog-mern-backend:9b60953",
            "cpu": 512,
            "memory": 1024,
            "portMappings": [
                {
                    "containerPort": 3000,
                    "hostPort": 3000,
                    "protocol": "tcp",
                    "name": "blog-backend-http",
                    "appProtocol": "http"
                }
            ],
            "essential": true,
            "environment": [],
            "environmentFiles": [],
            "mountPoints": [],
            "volumesFrom": [],
            "secrets": [
                {
                    "name": "FRONTEND_URL",
                    "valueFrom": "arn:aws:secretsmanager:us-east-1:129494056630:secret:master/backend/FRONTEND_URL-13LPux"
                },
                {
                    "name": "MONGODB_URL",
                    "valueFrom": "arn:aws:secretsmanager:us-east-1:129494056630:secret:master/backend/MONGODB_URL-R61hWT"
                },
                {
                    "name": "NODE_ENV",
                    "valueFrom": "arn:aws:secretsmanager:us-east-1:129494056630:secret:master/backend/NODE_ENV-RMkBa1"
                },
                {
                    "name": "PORT",
                    "valueFrom": "arn:aws:secretsmanager:us-east-1:129494056630:secret:master/backend/PORT-7pqHBJ"
                },
                {
                    "name": "TOKEN",
                    "valueFrom": "arn:aws:secretsmanager:us-east-1:129494056630:secret:master/backend/TOKEN-o1P06T"
                }
            ],
            "ulimits": [],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "/ecs/blog-backend-td",
                    "awslogs-create-group": "true",
                    "awslogs-region": "ap-south-1",
                    "awslogs-stream-prefix": "ecs"
                },
                "secretOptions": []
            },
            "systemControls": []
        }
    ],
    "family": "blog-backend-td",
    "executionRoleArn": "arn:aws:iam::129494056630:role/ecsTaskExecutionRole",
    "networkMode": "awsvpc",
    "revision": 2,
    "volumes": [],
    "status": "ACTIVE",
    "requiresAttributes": [
        {
            "name": "com.amazonaws.ecs.capability.logging-driver.awslogs"
        },
        {
            "name": "ecs.capability.execution-role-awslogs"
        },
        {
            "name": "com.amazonaws.ecs.capability.ecr-auth"
        },
        {
            "name": "com.amazonaws.ecs.capability.docker-remote-api.1.19"
        },
        {
            "name": "ecs.capability.secrets.asm.environment-variables"
        },
        {
            "name": "ecs.capability.execution-role-ecr-pull"
        },
        {
            "name": "com.amazonaws.ecs.capability.docker-remote-api.1.18"
        },
        {
            "name": "ecs.capability.task-eni"
        },
        {
            "name": "com.amazonaws.ecs.capability.docker-remote-api.1.29"
        }
    ],
    "placementConstraints": [],
    "compatibilities": [
        "EC2",
        "FARGATE",
        "MANAGED_INSTANCES"
    ],
    "runtimePlatform": {
        "cpuArchitecture": "X86_64",
        "operatingSystemFamily": "LINUX"
    },
    "requiresCompatibilities": [
        "FARGATE"
    ],
    "cpu": "512",
    "memory": "1024",
    "registeredAt": "2026-06-11T04:19:35.522Z",
    "registeredBy": "arn:aws:iam::129494056630:root",
    "enableFaultInjection": false,
    "tags": []
}
```


## 13. Create Target Group

| Setting                | Value                             |
| ---------------------- | --------------------------------- |
| Target Type            | IP addresses                      |
| Target Group Name      | `blog-backend-tg`                 |
| Protocol               | HTTP                              |
| Port                   | 3000                              |
| IP Address Type        | IPv4                              |
| VPC                    | `vpc-0dff14cfe53eb4a19` (default) |
| Protocol Version       | HTTP1                             |
| Health Check Protocol  | HTTP                              |
| Health Check Path      | `/health`                         |

> The backend exposes `GET /health` returning `200 OK`, so use that path (not `/`).

### Advanced Health Check Settings

| Setting             | Value |
| ------------------- | ----- |
| Healthy threshold   | 2     |
| Unhealthy threshold | 3     |
| Timeout             | 5     |
| Interval            | 30    |
| Success codes       | 200   |

### Register Targets

- Do **not** register any targets manually — the ECS service registers task IPs automatically.
- Remove any auto-filled IP.
- **Registered Targets:** 0

## 14. Create Load Balancer

- Go to `EC2 -> Load Balancers`.
- Go to `Application Load Balancer`.

| Setting           | Value                              |
| ----------------- | ---------------------------------- |
| ALB               | `blog-backend-alb`                 |
| Scheme            | internet-facing                    |
| IP Address Type   | IPv4                               |
| Availability      | all subnets                        |
| Security group    | `blog-backend-sg-alb`              |
| Target group      | `blog-backend-tg` (created above)  |

### Security Group (creation) — `blog-backend-sg-alb`

- **Group name:** `blog-backend-sg-alb`
- **Description:** Allow HTTP traffic to the backend Application Load Balancer

**Inbound Rules**

| Type  | Protocol | Port | Source                    | Description        |
| ----- | -------- | ---- | ------------------------- | ------------------ |
| HTTP  | TCP      | 80   | Anywhere IPv4 (0.0.0.0/0) | Public API traffic |

If you plan to add HTTPS later:

| Type  | Protocol | Port | Source    |
| ----- | -------- | ---- | --------- |
| HTTPS | TCP      | 443  | 0.0.0.0/0 |

> The ALB listens on 80/443 publicly and forwards to the container on port **3000**.

## 15. Create a Service

Before creating the service, you must have these:

1. ECS Cluster — ✅ `blog-master` (reused)
2. Task Definition — ✅ `blog-backend-td`
3. Target Group — ✅ `blog-backend-tg`
4. ALB — ✅ `blog-backend-alb`
5. ECS Service — (this step)

### Name

- **Task definition family:** `blog-backend-td`
- **Task definition revision:** `1 (latest)`
- **Service name:** `blog-backend-service`

### Compute Configuration

- **Compute options:** `Launch type`

### Deployment Configurations

- **Strategy:** `Replica`
- **Desired tasks:** `1`

### Networking

- **VPC:** `default`
- **Subnets:** `default`
- 

### Security Group — `blog-backend-sg-ecs`

- **Security group name:** `blog-backend-sg-ecs`
- **Security group description:** `Security Group For Backend ECS`

| Setting   | Value                  |
| --------- | ---------------------- |
| Type      | Custom TCP             |
| Port      | 3000                   |
| Source    | `blog-backend-sg-alb`  |
| Public IP | ON                     |

> Only the ALB security group may reach the container on port 3000 — the container is not directly public.

### Load Balancing

- Use an existing load balancer (`blog-backend-alb`).
- Use an existing listener (HTTP : 80) → forward to `blog-backend-tg`.

### Target group 
- use an existing target group (`blog-backend-tg`).
- 



### Service Auto Scaling 
- policy name - `blog-backend-target-scaling`
- desired number of task - 1
- minimum number of task - 0
- maximum number of task - 1
- set the scaling polices

### scaling polices
- For 90% of applications, including your MERN blog, SaaS, Shopify app backend, etc., use Target Tracking.
- After adding a task, ECS waits before adding another. : scale out cooldown 
- After removing a task, ECS waits before removing another.

Min Tasks: 1 
Desired Tasks: 1
Max Tasks: 5

Policy Type:
Target Tracking

Metric:
ECSServiceAverageCPUUtilization

Target Value:
60

Scale-Out Cooldown:
60 seconds

Scale-In Cooldown:
300 seconds

## ✅ AWS Configuration Complete

- Everything is attached.
- Open the backend ALB DNS and hit `/health` to verify:
  - `http://blog-backend-alb-xxxxxxx.ap-south-1.elb.amazonaws.com/health`

## 16. Our Deployment Yaml Code

Saved at `.github/workflows/deploy-backend.yml`:

```yaml
name: Deploy Backend to Production ECS

on:
  push:
    branches:
      - master

  workflow_dispatch:
    inputs:
      image_tag:
        description: Image tag used to deploy
        required: true
        default: latest

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: blog-mern-backend
  AWS_DEPLOY_ROLE_ARN: arn:aws:iam::129494056630:role/github-actions-deploy-role
  ECS_CLUSTER: blog-master
  ECS_SERVICE: blog-backend-service
  ECS_TASK_FAMILY: blog-backend-td
  CONTAINER_NAME: blog-backend

permissions:
  contents: read
  id-token: write # required for requesting the OIDC JWT to authenticate with AWS

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout the repository
        uses: actions/checkout@v3

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image to Amazon ECR
        id: build-image
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          # On manual runs use the provided tag, otherwise use the short commit SHA (first 7 chars)
          IMAGE_TAG: ${{ github.event.inputs.image_tag || github.sha }}
        run: |
          IMAGE_TAG="${IMAGE_TAG:0:7}"
          docker build \
            -t "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" \
            -t "$REGISTRY/$ECR_REPOSITORY:latest" \
            .
          docker push "$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
          docker push "$REGISTRY/$ECR_REPOSITORY:latest"
          echo "Pushed $REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
          # Expose the full image reference for the ECS deploy steps below
          echo "image=$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> "$GITHUB_OUTPUT"

      - name: Download current ECS task definition
        run: |
          aws ecs describe-task-definition \
            --task-definition "$ECS_TASK_FAMILY" \
            --query taskDefinition \
            --output json > task-definition.json

      - name: Render new image into the task definition
        id: render-task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ steps.build-image.outputs.image }}

      - name: Deploy to Amazon ECS service
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.render-task-def.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

> **Note:** The deploy step re-uses whatever `environment` / `secrets` already exist on the live task definition (it only swaps the image), so your runtime env survives every deploy. To change env values, edit the task definition (or the Secrets Manager value) and let the next deploy pick it up.

## 17. Verify the Deployment

- Verify the backend ALB DNS.
- Go to `ALB -> DNS name`.
- `http://blog-backend-alb-xxxxxxx.ap-south-1.elb.amazonaws.com/health`
- Should return `{ "status": "OK", ... }`.

## 18. SSL the Backend URL

Same flow as the frontend (ACM → ALB listener), so the API is served over HTTPS.

### Getting the Certificate

- Go to `AWS Certificate Manager (ACM)`.
- Request a public certificate for the API subdomain:
  - `api.articleapp.<companyname>.in`
- **Validation method:** DNS
- **Key algorithm:** `RSA 2048`

### Validate via DNS

- Put the ACM CNAME name/value into Cloudflare.
- Wait for status `Issued`.

### After "Issued"

#### 1. Add HTTPS Listener

- `ALB / Load Balancers -> Listeners -> Add Listener`.

| Setting     | Value                          |
| ----------- | ------------------------------ |
| Protocol    | HTTPS                          |
| Port        | 443                            |
| Certificate | `api.articleapp.<companyname>.in` |
| Action      | Forward to `blog-backend-tg`   |

#### 2. Redirect HTTP → HTTPS

- Edit the `HTTP : 80` listener → action **Redirect to URL** → HTTPS 443, status `301`.

#### 3. Modify the ALB Security Group

Add HTTPS to `blog-backend-sg-alb`:

| Type  | Protocol | Port | Source    |
| ----- | -------- | ---- | --------- |
| HTTP  | TCP      | 80   | 0.0.0.0/0 |
| HTTPS | TCP      | 443  | 0.0.0.0/0 |

#### 4. Cloudflare DNS Record

| Setting | Value                                                  |
| ------- | ------------------------------------------------------ |
| Type    | CNAME                                                  |
| Name    | `api.articleapp`                                       |
| Target  | `blog-backend-alb-xxxxxxx.ap-south-1.elb.amazonaws.com`|
| Proxy   | Proxied (orange cloud)                                 |

Then `https://api.articleapp.<companyname>.in` works through **Cloudflare → ALB → ECS**.

> **Important — wire the two apps together after SSL:**
> - Set the frontend's API base URL to `https://api.articleapp.<companyname>.in` (rebuild the frontend so it's baked in).
> - Set the backend's `FRONTEND_URL` env to `https://articleapp.<companyname>.in` so CORS allows the frontend origin.

## 19. Cost Optimization

| Resource             | Action                                                          |
| -------------------- | --------------------------------------------------------------- |
| ALB                  | Delete it & recreate when needed — take a screenshot first.     |
| ECS Service          | Set the service's desired tasks to `0`.                         |
| Public VPC IP        | Attached to ECS, so leave it — no calls to the VPC, so no cost. |

---

## Summary — Backend resource names

| Resource              | Frontend (existing)     | Backend (new)            |
| --------------------- | ----------------------- | ------------------------ |
| ECR repository        | `blog-mern-frontend`    | `blog-mern-backend`      |
| ECS cluster           | `blog-master`           | `blog-master` (reused)   |
| OIDC role             | `github-actions-deploy-role` | same (reused)       |
| Task definition       | `blog-frontend-td`      | `blog-backend-td`        |
| Container name        | `blog-frontend`         | `blog-backend`           |
| Container port        | `80`                    | `3000`                   |
| Health check path     | `/`                     | `/health`                |
| Target group          | `blog-frontend-tg`      | `blog-backend-tg`        |
| ALB                   | `blog-frontend-alb`     | `blog-backend-alb`       |
| ALB security group    | `blog-frontend-sg-alb`  | `blog-backend-sg-alb`    |
| ECS security group    | `blog-frontend-sg-ecs`  | `blog-backend-sg-ecs`    |
| ECS service           | `blog-frontend-service` | `blog-backend-service`   |
| Env injection         | build-time (public)     | runtime via task def (secret) |
| Domain                | `articleapp.<company>.in` | `api.articleapp.<company>.in` |


## 20. Test the backend env thorugh task definition is working on not
- for temporarily pass the frontend url as localhost:5173
- now, run the frontend in local & test
-