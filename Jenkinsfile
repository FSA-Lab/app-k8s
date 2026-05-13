pipeline {
    agent { kubernetes { label 'cicd-agent' } }

    environment {
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-creds')
        DOCKERHUB_REPO        = 'hungnv2511'
        MANIFEST_REPO_URL     = 'https://github.com/FSA-Lab/app-k8s-manifests.git'
        MANIFEST_REPO_CREDS   = credentials('manifest-repo-creds')
        SERVICES              = 'auth-service inventory-service order-service payment-service'
    }

    options {
        timeout(time: 15, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    stages {
        stage('Build & Push') {
            steps {
                container('node') {
                    script {
                        env.SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                        sh "npm ci"
                    }
                }
                container('buildkit') {
                    sh "mkdir -p /root/.docker && echo '{\"auths\":{\"https://index.docker.io/v1/\":{\"auth\":\"'$(echo -n ${DOCKERHUB_CREDENTIALS_USR}:${DOCKERHUB_CREDENTIALS_PSW} | base64 -w0)'\"}}}' > /root/.docker/config.json"
                    script {
                        for (svc in SERVICES.split(' ')) {
                            sh "buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt filename=services/${svc}/Dockerfile --output type=image,name=docker.io/${DOCKERHUB_REPO}/${svc}:${env.SHORT_SHA},push=true"
                        }
                    }
                }
            }
        }

        stage('Update Manifests') {
            steps {
                container('node') {
                    sh 'curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash && mv kustomize /usr/local/bin/'
                    sh "git clone https://${MANIFEST_REPO_CREDS}@github.com/FSA-Lab/app-k8s-manifests.git manifests"
                    dir('manifests') {
                        sh "git checkout develop"
                        dir("k8s/overlays/staging") {
                            script {
                                for (svc in SERVICES.split(' ')) {
                                    sh "kustomize edit set image ${svc}=${DOCKERHUB_REPO}/${svc}:${env.SHORT_SHA}"
                                }
                            }
                        }
                        sh 'git config user.email "jenkins@ci.local"'
                        sh 'git config user.name "Jenkins CI"'
                        sh 'git add k8s/overlays/'
                        sh "git diff --cached --quiet || git commit -m 'ci: update image tags to ${env.SHORT_SHA}'"
                        sh "git push origin develop"
                    }
                }
            }
        }
    }

    post {
        success {
            echo "Done! Image tag: ${env.SHORT_SHA}. ArgoCD will auto-sync to staging."
        }
        failure {
            echo "FAILED — branch: ${env.BRANCH_NAME}, commit: ${env.SHORT_SHA}"
        }
    }
}
