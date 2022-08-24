#!/bin/bash

export DEBIAN_FRONTEND=noninteractive

echo "#-----------------------------#"
echo "#      _____ _____ __  __     #"
echo "#     / ____/ ____|  \/  |    #"
echo "#    | (___| (___ | \  / |    #"
echo "#     \___ \\\\___ \| |\/| |    #"
echo "#     ____) |___) | |  | |    #"
echo "#    |_____/_____/|_|  |_|    #"
echo "#-----------------------------#"
echo "# Satisfactory Server Manager #"
echo "#-----------------------------#"

TEMP_DIR=$(mktemp -d /tmp/XXXXX)
INSTALL_DIR="/opt/SSM"

FORCE=0
UPDATE=0
NOSERVICE=0
ISDEV=0

ISDOCKER=0

while [[ $# -gt 0 ]]; do
    key="$1"

    case $key in
    --force | -f)
        FORCE=1
        shift # past value
        ;;

    --update | -u)
        UPDATE=1
        shift # past value
        ;;
    --noservice)
        NOSERVICE=1
        shift
        ;;
    --dev)
        ISDEV=1
        shift
        ;;
    --installdir)
        INSTALL_DIR=$2
        shift
        shift
        ;;
    *)
        echo "Invalid option must be: [--force, --update, --noservice, --dev, --installdir=<Location>"
        exit 1
        ;;
    esac
done

PLATFORM="$(uname -s)"

if [ ! "${PLATFORM}" == "Linux" ]; then
    echo "Error: Install Script Only Works On Linux Platforms!"
    exit 1
fi

if [ -f /etc/os-release ]; then
    # freedesktop.org and systemd
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
elif type lsb_release >/dev/null 2>&1; then
    # linuxbase.org
    OS=$(lsb_release -si)
    VER=$(lsb_release -sr)
elif [ -f /etc/lsb-release ]; then
    # For some versions of Debian/Ubuntu without lsb_release command
    . /etc/lsb-release
    OS=$DISTRIB_ID
    VER=$DISTRIB_RELEASE
elif [ -f /etc/debian_version ]; then
    # Older Debian/Ubuntu/etc.
    OS=Debian
    VER=$(cat /etc/debian_version)
else
    echo "Error: This version of Linux is not supported for SSM"
    exit 2
fi

if [[ "${OS}" == *"Debian"* ]] || [[ "${OS}" == "Ubuntu" ]]; then

    apt-get -qq install apt-utils curl wget jq -y >/dev/null 2>&1

    curl --silent "https://api.github.com/repos/mrhid6/satisfactoryservermanager/releases/latest" >${TEMP_DIR}/SSM_releases.json

    if [ $ISDEV -eq 1 ]; then
        echo "Using Dev build of SSM"
        curl --silent "https://api.github.com/repos/mrhid6/satisfactoryservermanager/releases" | jq -r "first(.[])" >${TEMP_DIR}/SSM_releases.json
    fi

    SSM_VER=$(cat ${TEMP_DIR}/SSM_releases.json | jq -r ".tag_name")
    SSM_URL=$(cat ${TEMP_DIR}/SSM_releases.json | jq -r ".assets[].browser_download_url" | grep -i "Linux" | sort | head -1)

    if [ -d "${INSTALL_DIR}" ]; then
        if [[ ${UPDATE} -eq 0 ]] && [[ ${FORCE} -eq 0 ]]; then
            echo "Error: SSM is already installed!"
            exit 1
        else
            if [ -f "${INSTALL_DIR}/version.txt" ]; then
                SSM_CUR=$(cat ${INSTALL_DIR}/version.txt)

                if [[ "${SSM_CUR}" == "${SSM_VER}" ]] && [[ ${FORCE} -eq 0 ]]; then
                    echo "Skipping update version already installed!"
                    exit 0
                fi

                echo "Updating SSM ${SSM_CUR} to ${SSM_VER} ..."
            else
                echo "Updating SSM v0.0.0 to ${SSM_VER} ..."
            fi
        fi
    else
        echo "Installing SSM ${SSM_VER} ..."
        mkdir -p ${INSTALL_DIR}
    fi

    echo "Installing Prereqs"
    apt-get -qq update -y >/dev/null 2>&1
    apt-get -qq upgrade -y >/dev/null 2>&1
    ln -fs /usr/share/zoneinfo/Europe/London /etc/localtime
    apt-get -qq install -y tzdata >/dev/null 2>&1
    dpkg-reconfigure --frontend noninteractive tzdata >/dev/null 2>&1

    apt-get -qq install binutils software-properties-common libcap2-bin -y >/dev/null 2>&1
    add-apt-repository multiverse -y >/dev/null 2>&1
    dpkg --add-architecture i386 >/dev/null 2>&1
    apt-get -qq update -y >/dev/null 2>&1
    apt-get -qq install lib32gcc1 -y >/dev/null 2>&1

    CheckDockerContainer=$(grep 'docker\|lxc' /proc/1/cgroup | wc -l)

    if [ $CheckDockerContainer -gt 0 ]; then
        ISDOCKER=1
    fi
else
    echo "Error: This version of Linux is not supported for SSM"
    exit 2
fi

if [[ "${OS}" == "Ubuntu" ]] && [[ "${VER}" != "20.04" ]]; then
    check_lib=$(strings /usr/lib/x86_64-linux-gnu/libstdc++.so.6 | grep GLIBCXX_3.4.26 | wc -l)

    if [ $check_lib -eq 0 ]; then
        add-apt-repository ppa:ubuntu-toolchain-r/test -y >/dev/null 2>&1
        apt-get -qq update -y >/dev/null 2>&1
        apt-get -qq upgrade -y >/dev/null 2>&1
    fi

    check_lib=$(strings /usr/lib/x86_64-linux-gnu/libstdc++.so.6 | grep GLIBCXX_3.4.26 | wc -l)

    if [ $check_lib -eq 0 ]; then
        echo "Error: Couldn't install required libraries"
        exit 1
    fi
fi

if id "ssm" &>/dev/null; then
    usermod -u 9999 ssm
    groupmod -g 9999 ssm

    chown -R ssm:ssm /home/ssm
    chown -R ssm:ssm /opt/SSM
else
    useradd -m ssm -u 9999 -s /bin/bash >/dev/null 2>&1
fi

if [ $ISDOCKER -eq 0 ]; then
    echo "Installing Docker"
    wget -q https://get.docker.com/ -O - | sh >/dev/null 2>&1

    groupadd docker >/dev/null 2>&1
    usermod -aG docker ssm
fi

if [ ${NOSERVICE} -eq 0 ]; then
    SSM_SERVICENAME="SSM.service"
    SSM_SERVICEFILE="/etc/systemd/system/SSM.service"
    SSM_SERVICE=$(
        systemctl list-units --full -all | grep -Fq "${SSM_SERVICENAME}"
        echo $?
    )

    if [ ${SSM_SERVICE} -eq 0 ]; then
        echo "Stopping SSM Service"
        systemctl stop ${SSM_SERVICENAME}
    fi
fi

echo "* Downloading SSM"
rm -r ${INSTALL_DIR}/* >/dev/null 2>&1

wget -q "${SSM_URL}" -O "${INSTALL_DIR}/SSM.tar.gz"
tar xzf "${INSTALL_DIR}/SSM.tar.gz" -C "${INSTALL_DIR}"
rm "${INSTALL_DIR}/SSM.tar.gz" >/dev/null 2>&1
rm "${INSTALL_DIR}/build.log" >/dev/null 2>&1
echo ${SSM_VER} >"${INSTALL_DIR}/version.txt"

chmod -R 777 ${INSTALL_DIR}
chown -R ssm:ssm ${INSTALL_DIR}

setcap cap_net_bind_service=+ep $(readlink -f /opt/SSM/SatisfactoryServerManager)

echo "* Cleanup"
rm -r ${TEMP_DIR}

if [ -d "/SSMAgents" ]; then
    chown -R ssm:ssm /SSMAgents
    chmod -R 755 /SSMAgents
else
    mkdir /SSMAgents
    chown -R ssm:ssm /SSMAgents
    chmod -R 755 /SSMAgents
fi

if [ ${NOSERVICE} -eq 0 ]; then
    echo "Creating SSM Service"
    ENV_SYSTEMD=$(pidof systemd | wc -l)
    ENV_SYSTEMCTL=$(which systemctl | wc -l)

    if [[ ${ENV_SYSTEMD} -eq 0 ]] && [[ ${ENV_SYSTEMCTL} -eq 0 ]]; then
        echo "Error: Cant install service on this system!"
        exit 3
    fi

    if [ ${SSM_SERVICE} -eq 0 ]; then
        echo "* Removing Old SSM Service"
        systemctl disable ${SSM_SERVICENAME} >/dev/null 2>&1
        rm -r "${SSM_SERVICEFILE}" >/dev/null 2>&1
        systemctl daemon-reload >/dev/null 2>&1
    fi

    echo "* Create SSM Service"

    cat >>${SSM_SERVICEFILE} <<EOL
[Unit]
Description=SatisfactoryServerManager Daemon
After=network.target

[Service]
User=ssm
Group=ssm

Type=simple
WorkingDirectory=/opt/SSM
ExecStart=/opt/SSM/SatisfactoryServerManager
TimeoutStopSec=20
KillMode=process
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOL
    echo "* Start SSM Service"
    systemctl daemon-reload >/dev/null 2>&1
    systemctl enable ${SSM_SERVICENAME} >/dev/null 2>&1
    systemctl start ${SSM_SERVICENAME} >/dev/null 2>&1

else
    echo "SSM Service Skipped"
fi
