def summarize(latencies):
    return sum(latencies) / len(latencies)


def latency_percentile(latencies, p):
    ordered = sorted(latencies)
    return ordered[int(len(ordered) * p)]


def report(latencies):
    return {"mean": summarize(latencies), "p95": percentile(latencies, 0.95)}
