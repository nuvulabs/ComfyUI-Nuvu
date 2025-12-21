<img width="960" height="544" alt="nuvuNoOutline" src="https://github.com/user-attachments/assets/cedba9aa-5f63-4836-beda-a59c9e0fec94" />

> **Usage License:** nuvu Labs grants you a limited license to run the nuvu plugin inside ComfyUI for its intended functionality in commercial or non-commercial workflows. Any other commercial use—including copying, modifying, sublicensing, or redistributing this code or derivative works—requires prior written consent from nuvu Labs.

### **nuvu makes private AI generation in ComfyUI effortless — built for film and VFX artists who demand privacy, polish, and more time to create. A plug-in right in ComfyUI, which makes the newest, professional-level, workflows a click away.**

## About nuvu Labs

nuvu Labs is an agency that excels at implementing, scaling, and finetuning AI pipelines in the film and VFX industries. We focus on security and data because your content is your backbone, and uploading your content to any cloud AI service risks your content becoming training material in the future.

## Table of Contents

- [The nuvu Advantage](#the-nuvu-advantage)
- [Installing nuvu](#installing-nuvu)
  - [Auto-Installers](#auto-installers)
  - [Comfy Manager](#comfy-manager)
  - [Manual Install](#manual-install)
  - [RunPod Template](#runpod-template)
- [Create an Account](#create-an-account)
  - [Free Features](#free-features)
  - [Paid Features](#paid-features)
  - [How to create an account](#how-to-create-an-account)
  - [How to subscribe](#how-to-subscribe)
- [Using nuvu](#using-nuvu)
  - [ComfyUI Optimizer](#comfyui-optimizer)
  - [Workflow Installer](#workflow-installer)
    - [Subgraphs](#subgraphs)
  - [Model Installer](#model-installer)
  - [Install Missing (Coming Soon)](#install-missing-coming-soon)
- [User Configuration](#user-configuration)
- [How Can We Help?](#how-can-we-help)
- [Logout](#logout)

## The nuvu Advantage

The nuvu Plug-in for ComfyUI gives you instant access to premium workflows specifically designed for production pipelines. The nuvu difference is when you download a workflow, you get everything needed to run the workflow. No more searching for obscure custom nodes or models. On top of that, the workflows are condensed into easy-to-use subgraphs that can be searched just like any node. Let's walk through an example.

Let's install Z-Image-Turbo
![alt text](docs/images/z-image-turbo-download.png)

After clicking Install, all workflows, subgraphs, custom nodes, and models for running Z-Image-Turbo will install.
![alt text](docs/images/z-image-download-summary.png)

Now let's restart ComfyUI, and check out what was installed for us!

This is the workflow that was downloaded. It contains a Z-Image-Turbo subgraph with documentation for what all of the inputs and outputs of the subgraph do. The models were already installed, so just click "Run" and as long as you have the VRAM to run the workflow, it will run immediately.

![alt text](docs/images/z-image-turbo-workflow-image.png)

Here is the searchable subgraph. Search for it as you would any other node, and connect it into your favorite image-to-video workflow or anywhere else you'd like.
![alt text](docs/images/z-image-subgraph.png)

nuvu has created an extremely efficient pipeline for getting workflows into your hands quickly, so when a new model is released, nuvu is committed to delivering the capability to you quickly and seamlessly.

## Installing nuvu

nuvu Labs offers a variety of ways to install the nuvu Plug-in into ComfyUI for optimal convenience.

### Auto-Installers

Download the applicable script for your system, which can be found [at this link](https://github.com/nuvulabs/ComfyUI-Nuvu/releases).

#### Windows Install
Place the .bat file in the folder location on windows that you want to install ComfyUI-nuvu in. Double click on the .bat file, and it will start to install ComfyUI with nuvu.
![alt text](docs/images/batFileInstall.png)

Inside the ComfyUI Folder, you will find a file called "run_comfy.bat". Double click this file to launch ComfyUI. Wait until the terminal stops producing text and then go to the next step.
![alt text](docs/images/batRunComfy.png)

Navigate to [localhost:8188](localhost:8188) or [127.0.0.1:8188](127.0.0.1:8188) in your web browser of choice (Firefox or Google Chrome recommended).

#### Linux Install
Place the .sh file in the folder location that you want to install ComfyUI-nuvu in. Open a shell and run:

```./linux_install_nuvu_comfy.sh```

This will clone ComfyUI into your current folder. Inside the ComfyUI Folder, you will find a file called "run_comfy.sh". Double click this file or open a shell and run it to launch ComfyUI. Wait until the terminal stops producing text and then go to the next step

Navigate to [localhost:8188](localhost:8188) or [127.0.0.1:8188](127.0.0.1:8188) in your web browser of choice (Firefox or Google Chrome recommended).

### Comfy Manager

test2

### RunPod Template

Use our referral code to sign up for RunPod if you don't already have an account! [https://runpod.io?ref=rqu7tin8](https://runpod.io?ref=rqu7tin8)

nuvu Labs provides a RunPod template to quickly deploy ComfyUI from anywhere, even if you don't own a GPU yourself. You can find it [at this link](https://console.runpod.io/deploy?template=ntf53vsuqj&ref=rqu7tin8)

When you click on the link and have a valid account created, you'll be prompted to start a pod.
![RunPod select pod](docs/images/RunPodPods.png)

nuvu Labs recommends setting up Network storage of 500gb minimum, preferably up to 1TB or more to handle the large size of the models. This will allow you to keep all your work and you won't have to restart all over again each time you start a new pod.

Select your network storage, and CUDA Versions as shown below. CUDA 12.8 or 12.9 are required becasue of blackwell architecture support for RTX 50xx series.
![Pod Storage and Cuda Settings](docs/images/PodStorageCuda.png)

Then select a GPU from the list below. For most production work, nuvu Labs recommends an RTX 5090 at minimum. RTX 5090 is an excellent balance of speed and value.

Once you've selected your GPU, and confirm that the ComfyUI-nuvu template is selected, click "Deploy On-Demand"
![Confirm Template and click deploy](docs/images/ConfirmTemplate.png)

If this is your first time launching ComfyUI on your network storage or if you do not plan to use a network storage, expect about 20mins of first time setup.

Go to the logs of your RunPod pod, and wait until you see the circled message in the container logs. That tells you that ComfyUI is ready.
![Look for comfyui browser address in logs](docs/images/podStartup.png)

Click "Connect", and then click "ComfyUI" to open ComfyUI. A JupyterLab session is also provided, where you can view the pod's filesystem.
![alt text](docs/images/podComfyUIStart.png)

### Docker
The docker command to run the ComfyUI-nuvu container is:
```
docker run -d \
  --name comfy-nuvu \
  --gpus all \
  -p 8188:8188 \
  -p 8888:8888 \
  -v /path/to/workspace:/workspace \
  nuvulabs/comfyui-nuvu:latest
```

## Create an Account

### Free Features
  - PyTorch Version Switcher
  - Sage Attention Installer
  - Windows Triton Installer
  - Slow Depth & Pose Map Fix
  - Cuda Toolkit Installer
  - Windows Build Tools Installer
  - Launch Shell with Build Tools Activated

### Paid Features
 - Auto-Install 100+ top-quality curated and subgraphed workflows
 - 400+ workflows in the roadmap
 - Subgraphs published straight into your library to use as nodes
 - Model Auto-Installer
 - (coming soon) Install All Missing Models & Custom Nodes for a workflow

### How to create a free account

Once you have nuvu installed into ComfyUI, click on the nuvu button at the top of ComfyUI.
![alt text](docs/images/nuvuButton.png)

Click the "Continue with Login" button on the dialog that pops up. All authentication is handled by Auth0 for optimal user security. The only personal data that nuvu Labs stores are name and email address for account handling.
![alt text](docs/images/nuvuLogin.png)

Authenticate the Auth0 form with either email/password, github, or google.
![alt text](docs/images/nuvuLoginForm.png)

Once you've completed log-in, you should be re-directed back to ComfyUI, where you will see the nuvu Dashboard appear.
![alt text](docs/images/nuvuDashboard.png)

### How to subscribe to nuvu Premium

To purchase a license to access over 100 premium workflows and subgraphs, click the "Purchase License" button on the left side.

![alt text](docs/images/PurchaseLicense.png)

That will bring you to our nuvu Account Dashboard, where you can Upgrade your account to the paid version.
![alt text](docs/images/UpgradenuvuPremium.png)

All purchases are handled securely through Stripe. nuvu does not store any of your financial information, all financial transactions run through Stripe.
![alt text](docs/images/SubscribeButton.png)

After subscribing, head back to ComfyUI, refresh your browser, and you should see your account upgraded to "Premium Subscription" on the left side.

![alt text](docs/images/PremiumSubscription.png)

## Using nuvu

### ComfyUI Optimizer

### Workflow Installer

#### Subgraphs

### Model Installer

### Install Missing (Coming Soon!)
When Implemented, this will allow users to open any workflow in ComfyUI and nuvu will attempt to find all custom nodes and models needed for that workflow, and install them for you. No more searching through the manager or scouring huggingface to find the correct model.

### User Configuration

### How Can We Help?

### Logout

