import { Router } from "express";

const router = Router();

const LINEAR_API = "https://api.linear.app/graphql";

const TEAMS_QUERY = `
  query { teams { nodes { id name } } }
`;

const TEAM_STATES_QUERY = `
  query($id: String!) {
    team(id: $id) {
      states {
        nodes { id name type }
      }
    }
  }
`;

const USER_BY_EMAIL_QUERY = `
  query($email: String!) {
    users(filter: { email: { eq: $email } }) {
      nodes { id }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation($title: String!, $teamId: String!, $description: String, $stateId: String, $assigneeId: String) {
    issueCreate(input: { title: $title, teamId: $teamId, description: $description, stateId: $stateId, assigneeId: $assigneeId }) {
      success
      issue { id identifier title url }
    }
  }
`;

const ISSUES_QUERY = `
  query MyIssues {
    viewer {
      assignedIssues(
        filter: {
          state: { type: { nin: ["completed", "canceled"] } }
        }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          url
          priority
          priorityLabel
          dueDate
          state { name type color }
          labels { nodes { name color } }
        }
      }
    }
  }
`;

router.get("/issues", async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return res.json({ issues: [], error: "LINEAR_API_KEY not configured" });
  }

  try {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: ISSUES_QUERY }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ issues: [], error: text });
    }

    const data = await response.json();
    if (data.errors) {
      return res.json({ issues: [], error: data.errors[0].message });
    }

    const issues = data.data?.viewer?.assignedIssues?.nodes || [];
    res.json({ issues });
  } catch (err) {
    console.error("Linear API error:", err.message);
    res.status(500).json({ issues: [], error: err.message });
  }
});

router.get("/teams", async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return res.json({ teams: [], error: "LINEAR_API_KEY not configured" });
  }

  try {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: TEAMS_QUERY }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ teams: [], error: text });
    }

    const data = await response.json();
    if (data.errors) {
      return res.json({ teams: [], error: data.errors[0].message });
    }

    const teams = data.data?.teams?.nodes || [];
    res.json({ teams });
  } catch (err) {
    console.error("Linear API error:", err.message);
    res.status(500).json({ teams: [], error: err.message });
  }
});

router.get("/teams/:teamId/states", async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return res.json({ states: [], error: "LINEAR_API_KEY not configured" });
  }

  try {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: TEAM_STATES_QUERY,
        variables: { id: req.params.teamId },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ states: [], error: text });
    }

    const data = await response.json();
    if (data.errors) {
      return res.json({ states: [], error: data.errors[0].message });
    }

    const allStates = data.data?.team?.states?.nodes || [];
    const states = allStates.filter((s) =>
      ["unstarted", "started", "completed"].includes(s.type)
    );
    res.json({ states });
  } catch (err) {
    console.error("Linear API error:", err.message);
    res.status(500).json({ states: [], error: err.message });
  }
});

router.post("/issues", async (req, res) => {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ success: false, error: "LINEAR_API_KEY not configured" });
  }

  const { title, description, teamId, stateId } = req.body;
  if (!title || !teamId) {
    return res.status(400).json({ success: false, error: "title and teamId are required" });
  }

  try {
    // Resolve assignee from LINEAR_ASSIGNEE_EMAIL env var
    let assigneeId;
    const assigneeEmail = process.env.LINEAR_ASSIGNEE_EMAIL;
    if (assigneeEmail) {
      const userRes = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query: USER_BY_EMAIL_QUERY, variables: { email: assigneeEmail } }),
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        assigneeId = userData.data?.users?.nodes?.[0]?.id;
      }
    }

    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: CREATE_ISSUE_MUTATION,
        variables: { title, teamId, description: description || undefined, stateId: stateId || undefined, assigneeId: assigneeId || undefined },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ success: false, error: text });
    }

    const data = await response.json();
    if (data.errors) {
      return res.json({ success: false, error: data.errors[0].message });
    }

    const result = data.data?.issueCreate;
    res.json({
      success: result?.success || false,
      issue: result?.issue || null,
    });
  } catch (err) {
    console.error("Linear API error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
