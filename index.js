// noinspection JSUnresolvedVariable

// Node packages being used
const express = require("express");
const bodyParser = require("body-parser"); // Parses JSON bodies
const cookieParser = require("cookie-parser");
const app = express().use(bodyParser.text());
const port = process.env.PORT || 3000;
const axios = require("axios"); // Sends HTTP requests

// Configuration of our server
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Productboard and GitLab information
const PRODUCTBOARD_INTEGRATION_ID = process.env.PB_INTEGRATION_ID; // Productboard plugin integration ID
const PRODUCTBOARD_TOKEN = "Bearer " + process.env.PB_TOKEN; // Productboard API token to authorize requests
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID; // GitLab Project ID
const GITLAB_TOKEN = process.env.GITLAB_TOKEN; // Gitlab Personal Access Token

// Initial route to confirm app is running on Heroku
app.get("/", (req, res) => {
	res.send("This is a Heroku server hosting our Productboard <> GitLab integration");
});

// Route to authenticate plugin connection. More info here: https://developer.productboard.com/#tag/pluginIntegrations
app.get("/plugin", (req, res) => {
	res.setHeader("Content-type", "text/plain");
	res.status(200).send(req.query.validationToken);
});

// Optional route if webhooks from Productboard are needed to support a 2-way sync
app.get("/productboard-webhook", async (req, res) => {
	res.setHeader("Content-type", "text/plain");
	res.status(200).send(req.query.validationToken);
});

// Endpoint where POST requests from Productboard plugin will be sent. More info here: https://developer.productboard.com/#operation/postPluginIntegration
app.post("/plugin", async (req, res) => {
	// Gather information about the Productboard feature that is sending over the request
	const pbFeatureID = req.body.data.feature.id;
	const pbFeatureLink = req.body.data.feature.links.html;

	console.log("Productboard trigger is:", req.body.data.trigger);

	// Determine action on button trigger. Can be push, dismiss, or unlink.
	if (req.body.data.trigger === "button.push") {
		res.json({
			data: {
				connection: {
					state: "progress",
				},
			},
		});

		// Get data about Productboard feature getting pushed
		getProductboardFeature(pbFeatureID)
			.then((pbFeatureResponse) => {
				// Extract data about Productboard feature
				const featureName = pbFeatureResponse.data.data.name;
				const featureDescription = pbFeatureResponse.data.data.description;
				const featureLinkHtml = `<br><strong>Click <a href="${pbFeatureLink}" target="_blank">here</a> to see feature in Productboard</strong>`;
				console.log(`Productboard feature name is: ${featureName}`);

				// Create issue in Gitlab
				createGitlabIssue(featureName, featureDescription + featureLinkHtml)
					.then((gitlabIssueResponse) => {
						// Extract data about Gitlab issue
						const issueID = gitlabIssueResponse.data.id;
						const issueURL = gitlabIssueResponse.data.web_url;
						console.log(`Gitlab issue ID is: ${issueID}`);

						// Connect feature and issue
						createProductboardPluginIntegrationConnection(pbFeatureID, issueID, issueURL)
							.then((_) => console.log("Productboard feature connected to Gitlab issue."))
							.catch((error) => console.log("Error when connecting Productboard feature and Gitlab issue:", error));
					})
					.catch((error) => console.log("Error when creating GitLab issue:", error));
			})
			.catch((error) => console.log("Error when getting Productboard feature:", error));
	} else {
		// If button trigger is unlink or dismiss, set PB plugin connection to initial state (basically disconnected)
		res.json({
			data: {
				connection: {
					state: "initial",
				},
			},
		});
		console.log("Productboard feature is unlinked");
	}

	res.status(200).end();
});

// Endpoint for requests from Gitlab for status updates in plugin integration column. More info here: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#issue-events
app.post("/gitlab-webhook", async (req, _) => {
	// Extract information about the GitLab issue
	const gitlabIssueId = req.body.object_attributes.id;
	const gitlabIssueStatus = req.body.object_attributes.state;
	const gitlabIssueURL = req.body.object_attributes.url;
	console.log(`The Gitlab issue ID is: ${gitlabIssueId} and the state is: ${gitlabIssueStatus}`);

	// List all plugin integrations connections
	getProductboardPluginIntegrationsConnections()
		.then((pbConnectionsResponse) => {
			// Find the right plugin integration connection -> the tooltip must contain gitlab issue ID
			const pbConnection = pbConnectionsResponse.data.data.find((connection) => connection.connection.tooltip?.includes(gitlabIssueId));
			// Check if we found matching connection
			if (pbConnection) {
				console.log(`Connected Productboard feature ID is ${pbConnection.featureId}`);
				// Update the connection with new status
				updateProductboardPluginIntegrationConnection(pbConnection.featureId, gitlabIssueId, gitlabIssueStatus, gitlabIssueURL)
					.then((_) => console.log(`Productboard plugin integration connection status is now: ${gitlabIssueStatus} 🚀`))
					.catch((error) => console.log("Error updating Productboard plugin integration connection", error));
			}
		})
		.catch((error) => console.log("Error getting Productboard plugin integrations connections:", error));
});

// Initiating server to listen for requests
app.listen(port, () => {
	console.log(`GitLab integration is listening on port http://localhost:${port}`);
});

// Get Productboard feature information
function getProductboardFeature(featureId) {
	return sendProductboardRequest("get", `features/${featureId}`);
}

// Create Productboard plugin connection. More info here: https://developer.productboard.com/#operation/postPluginIntegration
function createProductboardPluginIntegrationConnection(featureID, issueID, issueURL) {
	const pbPluginIntegrationData = JSON.stringify({
		data: {
			connection: {
				state: "connected",
				label: "Opened",
				hoverLabel: `Issue ${issueID}`,
				tooltip: `Issue ${issueID}`,
				color: "blue",
				targetUrl: issueURL,
			},
		},
	});

	return sendProductboardRequest("put", `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections/${featureID}`, pbPluginIntegrationData);
}

// Get specific plugin integration data. More info here: https://developer.productboard.com/#operation/getPluginIntegrationConnection
function getProductboardPluginIntegrationsConnections() {
	return sendProductboardRequest("get", `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections/`);
}

// Update a plugin integration connection. More info here: https://developer.productboard.com/#operation/putPluginIntegrationConnection
function updateProductboardPluginIntegrationConnection(featureID, issueID, issueStatus, issueURL) {
	const pbPluginIntegrationData = JSON.stringify({
		data: {
			connection: {
				state: "connected",
				label: issueStatus,
				hoverLabel: `Issue ${issueID}`,
				tooltip: `Issue ${issueID}`,
				color: issueStatus === "opened" ? "blue" : "green",
				targetUrl: issueURL,
			},
		},
	});

	return sendProductboardRequest("put", `plugin-integrations/${PRODUCTBOARD_INTEGRATION_ID}/connections/${featureID}`, pbPluginIntegrationData);
}

// Structure for Axios requests sent to PB API. More info here: https://developer.productboard.com/#section/Introduction
function sendProductboardRequest(method, url, data = undefined) {
	return axios({
		method: method,
		url: `https://api.productboard.com/${url}`,
		headers: {
			"X-Version": "1",
			Authorization: PRODUCTBOARD_TOKEN,
			"Content-Type": "application/json",
		},
		data: data,
	});
}

// JSON data structure for creating GitLab issues. More info here: https://docs.gitlab.com/ee/api/issues.html#new-issue
function createGitlabIssue(title, description) {
	const gitlabIssueData = JSON.stringify({
		title: title,
		description: description,
	});

	return sendGitlabRequest("post", "issues", gitlabIssueData);
}

// Structure to send Axios requests to Gitlab API. More info here: https://docs.gitlab.com/ee/api/issues.html#new-issue
function sendGitlabRequest(method, url, data = undefined) {
	return axios({
		method: method,
		url: `https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/${url}`,
		headers: {
			"PRIVATE-TOKEN": GITLAB_TOKEN,
			"Content-Type": "application/json",
		},
		data: data,
	});
}
