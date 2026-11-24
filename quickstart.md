# MeetStream for Make quickstart

1. In a development Make organization, install the private Custom App and create a MeetStream API Key connection. Follow the [private installation guide](docs/development.md).
2. Add **Get a Bot** to a new scenario and run it with a bot ID from a meeting you control. For a completed post-call job, connect **Get the Latest Successful Transcription** to **Get a Transcript** using the returned transcript ID.
3. For a summary, import the two [Make AI summary workflows](docs/make-generated-summaries.md) and run them on demand. They generate from transcript text and retrieve the saved result from Make Data Store.
4. To use a calendar, CRM or recording workflow, bind the blueprints to your installed app ID with `npm run templates:bind -- APP_ID`. Import a bound blueprint, select your connections, and follow its [setup and test steps](templates/README.md). Each source blueprint starts with its execution gate disabled.
5. To receive verified meeting events, connect the [webhook relay](docs/webhook-relay.md) to **Watch Meeting Events**. Run the signed synthetic checks before enabling a destination workflow.
