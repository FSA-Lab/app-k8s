// Required Jenkins credentials:
//   dockerhub-creds      — Username/Password (DockerHub username + access token)
//   manifest-repo-creds  — Secret text (GitHub PAT with write access to app-k8s-manifests)
//   sonar-token          — Secret text (SonarQube token)
//
// Required Jenkins global env vars (Manage Jenkins > System > Global properties):
//   DOCKERHUB_REPO — DockerHub username (e.g., "johndoe")

pipeline {
    agent { kubernetes { label 'cicd-agent' } }

    environment {
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-creds')
        DOCKERHUB_REPO        = "${env.DOCKERHUB_REPO ?: 'yourdockerhub'}"
        MANIFEST_REPO_URL     = 'https://github.com/FSA-Lab/app-k8s-manifests.git'
        MANIFEST_REPO_CREDS   = credentials('manifest-repo-creds')
        SONAR_TOKEN           = credentials('sonar-token')
        SERVICES              = 'auth-service inventory-service order-service payment-service'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
        disableConcurrentBuilds()
    }

    stages {
        stage('Init') {
            steps {
                script {
                    env.SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()

                    def base = env.BRANCH_NAME == 'main' ? 'HEAD~1' : 'origin/main'
                    def changed = sh(script: "git diff --name-only ${base}...HEAD 2>/dev/null || echo ''", returnStdout: true).trim()

                    env.BUILD_AUTH       = changed.contains('services/auth-service')       ? 'true' : 'false'
                    env.BUILD_INVENTORY  = changed.contains('services/inventory-service')  ? 'true' : 'false'
                    env.BUILD_ORDER      = changed.contains('services/order-service')      ? 'true' : 'false'
                    env.BUILD_PAYMENT    = changed.contains('services/payment-service')    ? 'true' : 'false'

                    // If no service changes detected (e.g., first commit), build all
                    if (env.BUILD_AUTH == 'false' && env.BUILD_INVENTORY == 'false' &&
                        env.BUILD_ORDER == 'false' && env.BUILD_PAYMENT == 'false') {
                        env.BUILD_AUTH = 'true'
                        env.BUILD_INVENTORY = 'true'
                        env.BUILD_ORDER = 'true'
                        env.BUILD_PAYMENT = 'true'
                    }

                    echo "Branch: ${env.BRANCH_NAME} | SHA: ${env.SHORT_SHA}"
                    echo "Build → auth:${env.BUILD_AUTH} inventory:${env.BUILD_INVENTORY} order:${env.BUILD_ORDER} payment:${env.BUILD_PAYMENT}"
                }
            }
        }

        stage('Install') {
            steps {
                container('node') {
                    sh 'npm ci'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                container('node') {
                    withSonarQubeEnv('sonarqube') {
                        sh '''
                            npx sonar-scanner \
                              -Dsonar.projectKey=app-k8s \
                              -Dsonar.sources=services,shared \
                              -Dsonar.host.url=http://sonarqube-service.argocd.svc.cluster.local:9000 \
                              -Dsonar.token=$SONAR_TOKEN
                        '''
                    }
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 5, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        stage('Docker Build & Push') {
            parallel {
                stage('Build auth-service') {
                    when { environment name: 'BUILD_AUTH', value: 'true' }
                    steps {
                        container('buildkit') {
                            sh "buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt filename=services/auth-service/Dockerfile --output type=image,name=docker.io/${DOCKERHUB_REPO}/auth-service:${env.SHORT_SHA},push=true,registry.insecure=true"
                        }
                    }
                }
                stage('Build inventory-service') {
                    when { environment name: 'BUILD_INVENTORY', value: 'true' }
                    steps {
                        container('buildkit') {
                            sh "buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt filename=services/inventory-service/Dockerfile --output type=image,name=docker.io/${DOCKERHUB_REPO}/inventory-service:${env.SHORT_SHA},push=true,registry.insecure=true"
                        }
                    }
                }
                stage('Build order-service') {
                    when { environment name: 'BUILD_ORDER', value: 'true' }
                    steps {
                        container('buildkit') {
                            sh "buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt filename=services/order-service/Dockerfile --output type=image,name=docker.io/${DOCKERHUB_REPO}/order-service:${env.SHORT_SHA},push=true,registry.insecure=true"
                        }
                    }
                }
                stage('Build payment-service') {
                    when { environment name: 'BUILD_PAYMENT', value: 'true' }
                    steps {
                        container('buildkit') {
                            sh "buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt filename=services/payment-service/Dockerfile --output type=image,name=docker.io/${DOCKERHUB_REPO}/payment-service:${env.SHORT_SHA},push=true,registry.insecure=true"
                        }
                    }
                }
            }
        }

        stage('Update Manifest Repo') {
            steps {
                container('kustomize') {
                    script {
                        def overlay = env.BRANCH_NAME == 'main' ? 'prod' : 'staging'

                        // Clone manifest repo
                        sh "git clone https://${MANIFEST_REPO_CREDS}@github.com/FSA-Lab/app-k8s-manifests.git manifests"
                        dir('manifests') {
                            sh "git checkout ${env.BRANCH_NAME}"

                            // Update image tags
                            dir("k8s/overlays/${overlay}") {
                                for (svc in SERVICES.split(' ')) {
                                    sh "kustomize edit set image ${svc}=${DOCKERHUB_REPO}/${svc}:${env.SHORT_SHA}"
                                }
                            }

                            // Commit and push
                            sh 'git config user.email "jenkins@ci.local"'
                            sh 'git config user.name "Jenkins CI"'
                            sh 'git add k8s/overlays/'
                            sh "git diff --cached --quiet || git commit -m 'ci: update image tags to ${env.SHORT_SHA}'"
                            sh "git push origin ${env.BRANCH_NAME}"
                        }
                    }
                }
            }
        }
    }

    post {
        failure {
            echo "Pipeline failed — branch: ${env.BRANCH_NAME}, commit: ${env.SHORT_SHA}"
        }
        cleanup {
            container('buildkit') {
                sh 'buildctl prune --keep-duration 0 || true'
            }
        }
    }
}
