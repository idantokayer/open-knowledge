# Manual AWS deployment

This builds the current checkout, including unpublished changes. No AWS resources are created by these files.

For an AWS-managed MicroVM deployment, use ECS Fargate. For a self-managed Firecracker guest, the Docker image requires a Linux guest with Docker, networking and persistent storage already configured; this directory does not provision a Firecracker host, kernel or root filesystem.

## Test locally first

From the repository root:

```bash
docker compose -f docker/compose.local.yml up --build -d
curl --fail http://localhost:3010/readyz
docker compose -f docker/compose.local.yml logs -f
```

Open http://localhost:3010. This uses image `toluna-ok:local` and a separate persistent local content volume. The port is bound to loopback only. Read-only mode is enabled; browse and search documents to test it. Stop with `docker compose -f docker/compose.local.yml down`; the content volume is retained. GitHub sign-in remains available from Settings → Account while read-only mode is enabled. The local Compose setup stores your sign-in in a separate persistent home volume; it does not resume repository sync or allow content changes.

## Build and push to ECR

Install Docker Buildx and AWS CLI, authenticate to your AWS account, and run from the repository root. Set your region, account and a unique image tag:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=123456789012
export IMAGE_TAG=initial
export REGISTRY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
aws ecr create-repository --repository-name toluna-ok --region "$AWS_REGION"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/amd64 --tag "$REGISTRY/toluna-ok:$IMAGE_TAG" --push .
```

Skip repository creation if it already exists. Build for linux/arm64 and change the task's cpuArchitecture to ARM64 when using Graviton. The build installs Node 24, pnpm 12.8.1 and Rust, builds only the CLI and its dependencies, and installs the packed CLI into the runtime image.

## ECS Fargate

1. Create an ECS cluster, an ECR repository, and the CloudWatch log group `/ecs/toluna-ok` in the same region.
2. Create an ECS task execution role with the AmazonECSTaskExecutionRolePolicy managed policy and the ECS tasks trust policy.
3. Create EFS in the service VPC with mount targets in the task subnets. Create an access point with root path `/toluna-ok`, POSIX user UID/GID 1000, and root directory creation owner UID/GID 1000 with permissions 0750. The image runs as UID/GID 1000. Allow TCP 2049 into the EFS security group from the task security group.
4. Replace every `<...>` placeholder in `task-definition.json`, the content repository URL, branch and public origin. The template clones a public HTTPS repository; private repositories require a separate credential delivery setup. Register with `aws ecs register-task-definition --cli-input-json file://docker/aws/task-definition.json`.
5. Create a Fargate service with deployment minimum healthy percent 0 and maximum percent 100 to avoid two writers accessing the same state during replacement (updates have downtime). Use platform version 1.4.0 or LATEST, desired count 1, and the registered task definition. Use private subnets with NAT egress for ECR, git and issuer/JWKS access, or configure the required VPC endpoints and other egress. Give the tasks no public IP.
6. Attach an Application Load Balancer with an IP-type target group on HTTP port 3000 and health check `/readyz`. Allow task port 3000 only from the ALB security group. Set a service health check grace period of at least 120 seconds. Use an ACM certificate and HTTPS listener, and configure your DNS name to match OK_EXTERNAL_URL.
7. Put authentication at the HTTPS edge before forwarding application requests. Configure ALB Cognito/OIDC authentication for the web UI if appropriate. MCP clients need a compatible bearer-token authenticating gateway; ALB browser authentication alone does not provide that flow. Do not expose the unauthenticated application directly.

Keep one task for this single-repository deployment. EFS persists content across task replacements. Git updates are fetched only at startup, and applied with a fast-forward merge; divergent local edits stop startup rather than being discarded. To refresh content, replace the task. To update application code, push a new image tag, register a new task revision, and update the service. Roll back by selecting the previous task revision and image tag; back up EFS separately.

## Existing Linux VM or Firecracker guest

Install Docker on the guest. Copy `docker/runtime.env.example` to `docker/runtime/server.env`, replace its values, and restrict its permissions to 0600. The runtime directory is excluded from the image build context. Authenticate to ECR on the guest using a role with image-pull permissions, then run:

```bash
docker volume create toluna-ok-content
docker run --rm --user root --entrypoint chown --mount source=toluna-ok-content,target=/content "$REGISTRY/toluna-ok:$IMAGE_TAG" 1000:1000 /content
docker run -d --name toluna-ok --restart unless-stopped --env-file docker/runtime/server.env --publish 127.0.0.1:3000:3000 --mount source=toluna-ok-content,target=/content "$REGISTRY/toluna-ok:$IMAGE_TAG"
curl --fail http://127.0.0.1:3000/readyz
docker logs toluna-ok
```

Place an authenticating HTTPS reverse proxy in front of the loopback port. Persist the Docker volume on the guest's durable disk. The VM setup is an alternative to Fargate, not an additional step.

For a private SSH content repository on a VM, mount a read-only deployment key and a verified known-hosts file under `/run/secrets`, readable by UID 1000. Set GIT_SSH_KEY_FILE and GIT_KNOWN_HOSTS_FILE to their container paths and use an SSH GIT_REPO_URL. The entrypoint copies the key with restrictive permissions and requires strict host-key checking. Do not bake keys into images or place credentials in the repository URL.

## Configuration and access

The wrapper preserves `.ok/config.yml` and `.ok/local/config.yml`; configure local remoteAuth settings in the latter if using the application's verified-token role mapping. The container defaults OK_ALLOW_EXTERNAL=1 and OK_READ_ONLY=1, disables idle shutdown, and binds port 3000. Set OK_EXTERNAL_URL to the browser-facing HTTPS origin.

In this checkout, OK_READ_ONLY gates writes across MCP, mutating HTTP routes and collaboration connections, and the web UI reflects the read-only state. It does not replace authentication. EFS stays writable because the server needs local state. Older published releases may gate MCP only; this image builds the checkout rather than installing a published release.

## References

- [AWS Firecracker and Fargate](https://aws.amazon.com/about-aws/whats-new/2018/11/firecracker-lightweight-virtualization-for-serverless-computing/)
- [ECR image push instructions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/getting-started-cli.html)
- [EFS with ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html)
- [ALB authentication](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
