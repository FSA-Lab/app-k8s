pipeline {
    agent { kubernetes { label 'cicd-agent' } }

    environment {
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-creds')
        DOCKERHUB_REPO        = "${env.DOCKERHUB_REPO ?: 'hungnv2511'}'
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
                container('docker') {
                    sh "echo $DOCKERHUB_CREDENTIALS_PSW | docker login -u $DOCKERHUB_CREDENTIALS_USR --password-stdin"
                    sh "docker build -t ${DOCKERHUB_REPO}/auth-service:${env.SHORT_SHA} -f services/auth-service/Dockerfile ."
                    sh "docker push ${DOCKERHUB_REPO}/auth-service:${env.SHORT_SHA}"
                    sh "docker build -t ${DOCKERHUB_REPO}/inventory-service:${env.SHORT_SHA} -f services/inventory-service/Dockerfile ."
                    sh "docker push ${DOCKERHUB_REPO}/inventory-service:${env.SHORT_SHA}"
                    sh "docker build -t ${DOCKERHUB_REPO}/order-service:${env.SHORT_SHA} -f services/order-service/Dockerfile ."
                    sh "docker push ${DOCKERHUB_REPO}/order-service:${env.SHORT_SHA}"
                    sh "docker build -t ${DOCKERHUB_REPO}/payment-service:${env.SHORT_SHA} -f services/payment-service/Dockerfile ."
                    sh "docker push ${DOCKERHUB_REPO}/payment-service:${env.SHORT_SHA}"
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
                            for (svc in SERVICES.split(' ')) {
                                sh "kustomize edit set image ${svc}=${DOCKERHUB_REPO}/${svc}:${env.SHORT_SHA}"
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
