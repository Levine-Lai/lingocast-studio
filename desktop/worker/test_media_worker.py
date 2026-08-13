import io
import json
import unittest

from media_worker import PIPELINE_STAGES, handle_message, serve


class MediaWorkerTests(unittest.TestCase):
    def test_health_reports_editor_and_pipeline_capabilities(self):
        result = handle_message({"id": "one", "command": "health"})
        self.assertEqual(result["id"], "one")
        self.assertEqual(result["protocol"], 1)
        self.assertTrue(result["result"]["editorReady"])
        self.assertEqual(tuple(result["result"]["stages"]), PIPELINE_STAGES)

    def test_json_lines_protocol_survives_invalid_input(self):
        source = io.StringIO("not-json\n" + json.dumps({"id": 2, "command": "pipeline_contract"}) + "\n")
        destination = io.StringIO()
        self.assertEqual(serve(source, destination), 0)
        lines = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertIn("error", lines[0])
        self.assertEqual(lines[1]["id"], 2)
        self.assertIn("awaiting_review", lines[1]["result"]["stages"])

    def test_unknown_commands_fail_explicitly(self):
        result = handle_message({"id": 3, "command": "invented"})
        self.assertIn("unknown command", result["error"]["message"])


if __name__ == "__main__":
    unittest.main()
