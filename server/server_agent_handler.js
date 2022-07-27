const {
    Docker
} = require('node-docker-api');

const Config = require("./server_config");
const logger = require("./server_logger");

const platform = process.platform;

const AgentAPI = require("./server_agent_api");
const SSM_Log_Handler = require("./server_log_handler");

const IAgent = require("../objects/obj_agent");

const UserManager = require("./server_user_manager");
const DB = require("./server_db");

const fs = require("fs-extra")
const path = require("path");

const DockerAPI = require("./server_docker_api");

const NotificationHandler = require("./server_notifcation_handler");

const ObjNotifyAgentCreated = require("../objects/notifications/obj_notify_agentcreated");
const ObjNotifyAgentStarted = require("../objects/notifications/obj_notify_agentstarted");
const ObjNotifyAgentShutdown = require("../objects/notifications/obj_notify_agentshutdown");

const ObjNotifyServerStarting = require("../objects/notifications/obj_notify_serverstarting");
const ObjNotifyServerRunning = require("../objects/notifications/obj_notify_serverrunning");
const ObjNotifyServerStopping = require("../objects/notifications/obj_notify_serverstopping");
const ObjNotifyServerOffline = require("../objects/notifications/obj_notify_serveroffline");





const promisifyStream = (stream) => new Promise((resolve, reject) => {
    stream.on('data', (d) => {})
    stream.on('end', resolve)
    stream.on('error', reject)
});



class AgentHandler {
    constructor() {

        let dockerSettings = {
            host: "http://127.0.0.1",
            port: 2375
        }

        if (platform != "win32") {
            dockerSettings = {
                socketPath: "/var/run/docker.sock"
            }
        }

        this._docker = new Docker(dockerSettings);

        this._AGENTS = [];
    }

    init = async() => {
        try {
            logger.info("[AGENT_HANDLER] - Pulling Docker Image..");
            await DockerAPI.PullDockerImage();
            logger.info("[AGENT_HANDLER] - Pulled Docker Image Successfully!");
            await this.BuildAgentList();

        } catch (err) {
            console.log(err);
        }
    }


    BuildAgentList = async() => {

        logger.info("[AGENT_HANDLER] - Building SSM Agent List...");
        try {
            const SQL = `SELECT * FROM agents`
            const rows = await DB.query(SQL);

            if (this._AGENTS.length == 0 || this._AGENTS.length != rows.length) {
                this._AGENTS = [];

                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const Agent = new IAgent();
                    Agent.parseDBData(row);
                    this._AGENTS.push(Agent);
                }
            }
        } catch (err) {
            throw err;
        }

        try {
            // Validate Agent Docker ID
            for (let i = 0; i < this._AGENTS.length; i++) {
                const Agent = this._AGENTS[i];
                const existsID = await DockerAPI.CheckDockerContainerExists(Agent.getDockerId())

                if (existsID == false) {
                    const existsName = await DockerAPI.CheckDockerContainerExistsWithName(Agent.getName())
                    if (existsName == false) {
                        Agent._docker_id = null;
                    } else {
                        const containers = await DockerAPI.GetDockerContainersWithName(Agent.getName())
                        const container = containers[0];
                        Agent._docker_id = container.id;
                    }
                }

                await this.SaveAgent(Agent);
            }
        } catch (err) {
            throw err;
        }


        try {
            // Update Agent Docker Running State
            for (let i = 0; i < this._AGENTS.length; i++) {
                const Agent = this._AGENTS[i];

                if (Agent.isValid()) {
                    const container = await DockerAPI.GetDockerContainerByID(Agent.getDockerId());
                    if (container.data != null) {
                        Agent._running = container.data.State.Status == "running"
                    } else {
                        Agent._running = false;
                    }


                } else {
                    Agent._running = false;
                }

                await this.SaveAgent(Agent);
            }

        } catch (err) {
            throw err;
        }
    }


    SaveAgent = async(Agent) => {

        const sql = "UPDATE agents SET agent_running=?, agent_docker_id=?, agent_active=? WHERE agent_id=?"
        const sqlData = [
            (Agent.isRunning() ? 1 : 0),
            Agent.getDockerId(),
            (Agent.isActive() ? 1 : 0),
            Agent.getId()
        ]

        await DB.queryRun(sql, sqlData);

    }

    GetAgentByDockerId(id) {
        return this._AGENTS.find(agent => agent.getDockerId() == id);
    }

    GetAllAgents() {
        return this._AGENTS;
    }

    GetAgentById(id) {
        return this._AGENTS.find(agent => agent.getId() == id);
    }

    GetAgentByDisplayName(name) {
        return this._AGENTS.find(agent => agent.getDisplayName().toLowerCase() == name.toLowerCase());
    }

    GetAgentByServerPort(port) {
        return this._AGENTS.find(agent => agent.getServerPort() == port);
    }

    GetNewDockerInfo(ServerName, portOffset) {
        return {
            Name: "SSMAgent_" + ServerName,
            AgentPort: (3000 + portOffset),
            ServerQueryPort: (15776 + portOffset),
            BeaconPort: (14999 + portOffset),
            Port: (7776 + portOffset),
        }
    }

    FixAgentsMigrationPortData() {
        return new Promise((resolve, reject) => {
            const promises = [];

            this.GetAllAgents().forEach(Agent => {
                if (Agent.getSSMPort() == 0 && Agent.isRunning()) {

                    const Ports = Agent.getContainerInfo().Ports;
                    let BeaconPort = 0,
                        ServerPort = 0,
                        SSMPort = 0,
                        Port = 0;

                    if (Ports.length > 0) {
                        BeaconPort = Ports[0].PublicPort;
                        ServerPort = Ports[1].PublicPort;
                        SSMPort = Ports[2].PublicPort;
                        Port = Ports[3].PublicPort;
                    }

                    const SQL = `UPDATE agents SET agent_ssm_port=?, agent_serverport=?, agent_beaconport=?, agent_port=? WHERE agent_id=?`
                    const SQLData = [
                        SSMPort,
                        ServerPort,
                        BeaconPort,
                        Port,
                        Agent.getId()
                    ];
                    promises.push(DB.queryRun(SQL, SQLData));
                }
            })

            Promise.all(promises).then(() => {
                resolve();
            })

        });
    }

    CreateNewDockerAgent = async(UserID, Data) => {
        const UserAccount = UserManager.getUserById(UserID);

        if (UserAccount == null || typeof UserAccount == undefined) {
            reject(new Error("User Not Found!"));
            return;
        }

        if (!UserAccount.HasPermission("agentactions.create")) {
            reject(new Error("User Doesn't Have Permission!"));
            return;
        }


        const portOffset = Data.port - 15776;

        if (portOffset < 0) {
            reject(new Error("Server Port must be above 15776"))
            return;
        }

        const DisplayName = Data.name.replace(" ", "");


        const {
            Name,
            AgentPort,
            ServerQueryPort,
            BeaconPort,
            Port
        } = this.GetNewDockerInfo(DisplayName, portOffset)

        let ExistingAgent = this.GetAgentByServerPort(ServerQueryPort);

        if (ExistingAgent != null) {
            reject(new Error(`Server Instance with this port (${ServerQueryPort}) Already Exist!`))
            return;
        }

        ExistingAgent = this.GetAgentByDisplayName(DisplayName);

        if (ExistingAgent != null) {
            reject(new Error(`Server Instance with this name (${DisplayName}) Already Exist!`))
            return;
        }

        logger.info(`[AGENT_HANDLER] - Creating Agent (${DisplayName}) ...`);

        const PortBindings = {};

        PortBindings["3000/tcp"] = [{
            "HostPort": `${AgentPort}`
        }]

        PortBindings[`${ServerQueryPort}/udp`] = [{
            "HostPort": `${ServerQueryPort}`
        }]

        PortBindings[`${BeaconPort}/udp`] = [{
            "HostPort": `${BeaconPort}`
        }]

        PortBindings[`${Port}/udp`] = [{
            "HostPort": `${Port}`
        }]

        const ExposedPorts = {
            "3000/tcp": {}
        }

        ExposedPorts[`${ServerQueryPort}/udp`] = {}
        ExposedPorts[`${BeaconPort}/udp`] = {}
        ExposedPorts[`${Port}/udp`] = {}

        const TempBinds = [
            `/SSMAgents/${Name}/SSM:/home/ssm/.SatisfactoryServerManager`,
            `/SSMAgents/${Name}/.config:/home/ssm/.config/Epic/FactoryGame`,
        ]

        let Binds = []

        for (let i = 0; i < TempBinds.length; i++) {
            const Bind = TempBinds[i];
            const splitBind = Bind.split(":");
            const desiredMode = 0o2777
            const Dir = path.resolve(splitBind[0]);
            if (fs.existsSync(Dir) == false) {
                fs.ensureDirSync(Dir, desiredMode)
            }

            Binds.push(`${Dir}:${splitBind[1]}`)
        }

        const newContainer = await DockerAPI.CreateDockerContainer({
            Image: 'mrhid6/ssmagent:latest',
            name: Name,
            HostConfig: {
                Binds,
                PortBindings: PortBindings
            },
            ExposedPorts
        })

        logger.info("[AGENT_HANDLER] - Created agent successfully!");
        await this.CreateAgentInDB(newContainer, Name, DisplayName, AgentPort, ServerQueryPort, BeaconPort, Port)

        let Notification = new ObjNotifyAgentCreated(DisplayName);
        Notification.build();

        await NotificationHandler.StoreNotification(Notification);

        logger.info("[AGENT_HANDLER] - Starting Agent ...");
        await DockerAPI.StartDockerContainer(newContainer.id);
        logger.info("[AGENT_HANDLER] - Agent Started!");

        await this.BuildAgentList();

        const Agent = this.GetAgentByDockerId(newContainer.id);
        Notification = new ObjNotifyAgentStarted(Agent);
        Notification.build();

        await NotificationHandler.StoreNotification(Notification);

        await AgentAPI.InitNewAgent(Agent);

    }

    CreateAgentInDB = async(container, Name, DisplayName, SSMPort, ServerPort, BeaconPort, Port) => {
        const SQL = "INSERT INTO agents(agent_name, agent_displayname, agent_docker_id, agent_ssm_port, agent_serverport, agent_beaconport, agent_port, agent_running) VALUES (?,?,?,?,?,?,?,?)"

        const SQLData = [
            Name,
            DisplayName,
            container.data.Id,
            SSMPort,
            ServerPort,
            BeaconPort,
            Port,
            0
        ];
        try {
            await DB.queryRun(SQL, SQLData)
        } catch (err) {
            throw err;
        }
    }

    RemoveAgentFromDB(Agent) {
        return new Promise((resolve, reject) => {
            const AgentID = Agent.getId();
            const SQL = "DELETE FROM agents WHERE agent_id=?";
            DB.queryRun(SQL, [Agent.getId()]).then(() => {
                resolve(AgentID);
            })
        });
    }


    DeleteAgent = async(UserID, Data) => {

        const UserAccount = UserManager.getUserById(UserID);

        if (UserAccount == null || typeof UserAccount == undefined) {
            throw new Error("User Not Found!");
        }

        if (!UserAccount.HasPermission("agentactions.delete")) {
            throw new Error("User Doesn't Have Permission!");
        }

        const Agent = this.GetAgentById(Data.agentid);

        if (Agent == null) {
            logger.error(`[AGENT_HANDLER] - Cant Find Agent ${Data.agentid}`);
            throw new Error("Agent is Null");
        }


        logger.info(`[AGENT_HANDLER] - Deleting Agent`);
        let VolumeID = "";


        try {
            logger.info(`[AGENT_HANDLER] - Stopping Agent`);
            await this.StopAgent(Agent);
            logger.info(`[AGENT_HANDLER] - Agent Stopped`);
        } catch (err) {
            throw err;
        }


        try {
            const container = await DockerAPI.GetDockerContainerByID(Agent.getDockerId())

            if (container != null) {
                VolumeID = container.data.Mounts[0].Name;
                await DockerAPI.DeleteDockerContainerById(Agent.getDockerId())
                logger.info(`[AGENT_HANDLER] - Docker Deleted`);

                const DockerConnection = await DockerAPI.ConnectDocker();
                const Volume = await DockerConnection.volume.get(VolumeID);

                if (Volume != null) {
                    await Volume.remove({
                        force: true
                    });
                    logger.info(`[AGENT_HANDLER] - Docker Volume Deleted`);
                }
            }
            await this.RemoveAgentFromDB(Agent);

            logger.info(`[AGENT_HANDLER] - Agent Deleted!`);

            await this.BuildAgentList();
        } catch (err) {
            throw err;
        }

    }

    UpdateAgent(UserID, Data) {
        return new Promise((resolve, reject) => {
            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission("agentactions.delete") || !UserAccount.HasPermission("agentactions.create")) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(Data.agentid)

            if (Agent == null) {
                reject(new Error("Agent Not Found!"));
                return;
            }

            Data.port = Agent.getServerPort();
            Data.name = Agent.getDisplayName();

            this.DeleteAgent(UserID, Data).then(() => {
                return this.CreateNewDockerAgent(UserID, Data)
            }).then(() => {
                resolve();
            }).catch(reject);

        });
    }

    WaitForAgentToStart(Agent) {
        return new Promise((resolve, reject) => {
            const AgentId = Agent.getContainerInfo().Id;

            let interval = setInterval(() => {
                logger.debug("[AGENT_HANDLER] - Waiting for agent to start ...");

                this.BuildAgentList().then(() => {
                    const TempAgent = this.GetAgentByDockerId(AgentId);

                    if (TempAgent == null) {
                        return;
                    }

                    if (TempAgent.isActive() === true) {
                        resolve(TempAgent);
                        clearInterval(interval);
                    }
                }).catch(err => {})
            }, 5000)
        });
    }

    WaitForAgentToStop(Agent) {
        return new Promise((resolve, reject) => {
            const AgentId = Agent.getContainerInfo().Id;

            let interval = setInterval(() => {
                logger.debug("[AGENT_HANDLER] - Waiting for agent to stop ...");

                this.BuildAgentList().then(() => {
                    const TempAgent = this.GetAgentByDockerId(AgentId);

                    if (TempAgent == null) {
                        return;
                    }

                    if (TempAgent.isActive() === false && TempAgent.isRunning() == false) {
                        resolve(TempAgent);
                        clearInterval(interval);
                    }
                }).catch(err => {})
            }, 5000)
        });
    }

    CheckAllAgentsActive() {
        return new Promise((resolve, reject) => {
            const promises = [];

            for (let i = 0; i < this._AGENTS.length; i++) {
                const Agent = this._AGENTS[i];
                promises.push(AgentAPI.PingAgent(Agent))
            }

            Promise.all(promises).then(values => {
                for (let i = 0; i < values.length; i++) {
                    const active = values[i];
                    this._AGENTS[i].setActive(active);
                }
                return this.CheckAgentInfo()
            }).then(() => {
                resolve();
            }).catch(err => {
                reject(err);
            })
        });
    }

    CheckAgentInfo() {
        return new Promise((resolve, reject) => {
            const promises = [];
            for (let i = 0; i < this._AGENTS.length; i++) {
                const Agent = this._AGENTS[i];
                promises.push(AgentAPI.GetAgentInfo(Agent));
            }

            Promise.all(promises).then(values => {
                for (let i = 0; i < values.length; i++) {
                    const active = values[i];
                    this._AGENTS[i].setInfo(active);
                }
                resolve();
            }).catch(err => {
                reject(err);
            })
        })
    }

    StartDockerAgent(id, UserID) {

        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission("agentactions.start")) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            logger.info("[AGENT_HANDLER] - Starting Agent...");

            const Agent = this.GetAgentById(id);

            if (Agent == null) {
                logger.error(`[AGENT_HANDLER] - Cant Find Agent ${id}`);
                reject("Agent is Null");
                return;
            }

            Agent.getContainer().start().then(() => {
                return this.WaitForAgentToStart(Agent);
            }).then(() => {
                return this.BuildAgentList();
            }).then(() => {

                const Notification = new ObjNotifyAgentStarted(Agent);
                Notification.build();

                NotificationHandler.StoreNotification(Notification);

                logger.info("[AGENT_HANDLER] - Agent Started!");
                resolve();
            }).catch(err => {
                reject(err);
            })
        });
    }

    StopDockerAgent = async(id, UserID) => {


        const UserAccount = UserManager.getUserById(UserID);

        if (UserAccount == null || typeof UserAccount == undefined) {
            throw new Error("User Not Found!");
        }

        if (!UserAccount.HasPermission("agentactions.stop")) {
            throw new Error("User Doesn't Have Permission!");
        }

        logger.info("[AGENT_HANDLER] - Stopping Agent...");

        const Agent = this.GetAgentById(id);

        if (Agent == null) {
            logger.error(`[AGENT_HANDLER] - Cant Find Agent ${id}`);
            throw new Error("Agent is Null");
        }

        await this.StopAgent(Agent);
    }

    StopAgent = async(Agent) => {
        if (Agent.isActive() == false && Agent.isRunning() == false) {
            logger.info("[AGENT_HANDLER] - Agent Already Stopped!");
            return;
        }

        if (Agent.isActive() == false) {
            await DockerAPI.StopDockerContainer(Agent.getDockerId());
        } else {
            await AgentAPI.StopAgent(Agent)
        }

        await DockerAPI.WaitForContainerToStop(Agent.getDockerId());
        await this.BuildAgentList();

        const Notification = new ObjNotifyAgentShutdown(Agent);
        Notification.build();

        await NotificationHandler.StoreNotification(Notification);
        logger.info("[AGENT_HANDLER] - Agent Stopped!");
    }

    API_GetAllAgents() {
        return new Promise((resolve, reject) => {
            this.CheckAllAgentsActive().then(() => {
                const ResAgents = []
                for (let i = 0; i < this.GetAllAgents().length; i++) {
                    const agent = this.GetAllAgents()[i];
                    ResAgents.push(agent.getWebJson());
                }

                resolve(ResAgents);
            }).catch(err => {
                reject(err);
            })
        })
    }

    API_SetConfigSettings(ConfigKey, data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            const shortKey = ConfigKey.replace("settings", "");

            if (!UserAccount.HasPermission(`settings.agent.${shortKey}`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }


            AgentAPI.remoteRequestPOST(Agent, "config/" + ConfigKey, data).then(res => {
                if (res.data.result == "success") {
                    resolve();
                } else {
                    reject(new Error(res.data.error));
                }
            }).catch(err => {
                reject(err);
            })
        })
    }

    API_InstallSF(data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`serveractions.install`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestPOST(Agent, "installsf", {}).then(res => {
                if (res.data.result == "success") {
                    resolve();
                } else {
                    reject(new Error(res.data.error));
                }
            }).catch(err => {
                reject(err);
            })

        });
    }

    API_ExecuteServerAction(data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`serveractions.${data.action}`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }



            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            if (data.action == "start") {
                const Notification = new ObjNotifyServerStarting(Agent);
                Notification.build();

                NotificationHandler.StoreNotification(Notification);
            } else {
                const Notification = new ObjNotifyServerStopping(Agent);
                Notification.build();

                NotificationHandler.StoreNotification(Notification);
            }

            AgentAPI.remoteRequestPOST(Agent, "serveraction", data).then(res => {
                if (res.data.result == "success") {

                    if (data.action == "start") {
                        const Notification1 = new ObjNotifyServerRunning(Agent);
                        Notification1.build();

                        NotificationHandler.StoreNotification(Notification1);
                    } else {
                        const Notification1 = new ObjNotifyServerOffline(Agent);
                        Notification1.build();

                        NotificationHandler.StoreNotification(Notification1);
                    }

                    resolve();
                } else {
                    reject(new Error(res.data.error));
                }
            }).catch(err => {
                reject(err);
            })

        })
    }

    API_GetModInfo(data) {
        return new Promise((resolve, reject) => {

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestGET(Agent, `modinfo/${data.info}`).then(res => {
                if (res.data.result == "success") {
                    resolve(res.data.data);
                } else {
                    reject(new Error(res.data.error));
                }
            }).catch(err => {
                reject(err);
            })

        })
    }

    API_ExecuteModAction(data) {
        return new Promise((resolve, reject) => {

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestPOST(Agent, `modaction/${data.action}`, data).then(res => {
                if (res.data.result == "success") {
                    resolve();
                } else {
                    reject(new Error(res.data.error));
                }
            }).catch(err => {
                reject(err);
            })

        })
    }

    API_UploadSaveFile(fileData, data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`settings.saves.upload`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.UploadAgentSaveFile(Agent, fileData).then(res => {
                resolve(res)
            }).catch(err => {
                reject(err);
            })

        });
    }

    API_GetGameSaves(data) {
        return new Promise((resolve, reject) => {

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestGET(Agent, "gamesaves").then(res => {
                resolve(res.data.data)
            }).catch(err => {
                reject(err);
            })
        })
    }

    API_DeleteSaveFile(data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`settings.saves.delete`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestPOST(Agent, "gamesaves/delete", data).then(res => {
                resolve(res.data)
            }).catch(err => {
                reject(err);
            })
        })
    }

    API_DownloadSaveFile(data, UserID) {
        return new Promise((resolve, reject) => {


            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`settings.saves.download`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.DownloadAgentSaveFile(Agent, data.savefile).then(savefile => {
                resolve(savefile)
            }).catch(err => {
                reject(err);
            })
        });
    }

    API_GetLogs(LogType, data) {
        return new Promise((resolve, reject) => {

            if (data.agentid == -1 && LogType == "ssmlog") {
                SSM_Log_Handler.getSSMLog().then(logs => {
                    resolve(logs);
                    return;
                })
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is not defined!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            let query = "";

            if (LogType == "sfserverlog") {
                query = `?offset=${data.offset}`
            }

            AgentAPI.remoteRequestGET(Agent, `logs/${LogType}${query}`).then(res => {
                resolve(res.data.data);
            }).catch(err => {
                reject(err);
            })

        });
    }

    API_GetBackups(data, UserID) {
        return new Promise((resolve, reject) => {

            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`settings.backup.view`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }


            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is not defined!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.remoteRequestGET(Agent, "backups").then(res => {
                resolve(res.data.data);
            }).catch(err => {
                reject(err);
            })
        });
    }

    API_DownloadBackupFile(data, UserID) {
        return new Promise((resolve, reject) => {


            const UserAccount = UserManager.getUserById(UserID);

            if (UserAccount == null || typeof UserAccount == undefined) {
                reject(new Error("User Not Found!"));
                return;
            }

            if (!UserAccount.HasPermission(`settings.backup.download`)) {
                reject(new Error("User Doesn't Have Permission!"));
                return;
            }

            const Agent = this.GetAgentById(data.agentid)
            if (Agent == null) {
                reject(new Error("Agent is null!"))
                return;
            }

            if (Agent.isRunning() == false || Agent.isActive() == false) {
                reject(new Error("Agent is offline"))
                return;
            }

            AgentAPI.DownloadAgentBackupFile(Agent, data.backupfile).then(backupfile => {
                resolve(backupfile)
            }).catch(err => {
                reject(err);
            })
        });
    }
}

const agentHandler = new AgentHandler();
module.exports = agentHandler;