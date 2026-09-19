"""Compatibility wrapper for the operating-theatre scheduler.

This project originally shipped a very large optimizer module, but the runtime
had a broken import path. The Flask app expects the `Scheduler` contract from the
package under ``scheduler/optimizer.py``. Re-export the real implementation here so
older imports continue to work.
"""

from scheduler.optimizer import *
