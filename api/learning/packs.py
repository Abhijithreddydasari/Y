"""Small reference packs; the capture service has no subject-specific branches."""
from .contracts import Concept, Rubric, TaskSpec, TopicPack, VerifierSpec


PACKS = (
    TopicPack(
        pack_id="cv.geometry.v1", title="Stereo vision and image features",
        concepts=(
            Concept(concept_id="cv.disparity", title="Stereo disparity"),
            Concept(concept_id="cv.depth", title="Depth from stereo", prerequisites=("cv.disparity",)),
            Concept(concept_id="cv.weighted_sum", title="Local image filtering"),
        ),
        tasks=(
            TaskSpec(
                task_id="cv.stereo.depth.v1", pack_id="cv.geometry.v1",
                prompt="For a rectified stereo pair, focal length is 800 pixels, baseline is 0.2 metres, and disparity is 40 pixels. What is the depth in metres? Enter just the number. Then try the explanation task.",
                concept_ids=("cv.depth",),
                rubrics=(Rubric(dimension="mathematical", criterion="Computes depth Z=fB/d in metres with the given units."),),
                verifier=VerifierSpec(kind="stereo_depth", parameters={"focal_px": 800, "baseline_m": 0.2, "disparity_px": 40}),
                sources=("https://rbe549.github.io/spring2024/proj/p2/",),
            ),
            TaskSpec(
                task_id="cv.stereo.explain.v1", pack_id="cv.geometry.v1",
                prompt="In a rectified stereo pair with fixed focal length and baseline, an object's disparity doubles. Predict what happens to its depth and explain why. What makes a near-zero disparity estimate unreliable?",
                concept_ids=("cv.depth", "cv.disparity"),
                rubrics=(
                    Rubric(dimension="conceptual", criterion="Explains the inverse relationship Z=fB/d: doubling positive disparity halves depth at fixed focal length and baseline."),
                    Rubric(dimension="critical", criterion="Recognizes that small disparity errors cause large depth uncertainty near zero disparity; zero disparity does not give finite depth in this model."),
                ),
                sources=("https://rbe549.github.io/spring2024/proj/p2/",),
            ),
            TaskSpec(
                task_id="cv.weighted_sum.v1", pack_id="cv.geometry.v1",
                prompt="Compute the weighted sum of image values [2, 4, 1] with weights [-1, 0, 1]. Enter just the number.",
                concept_ids=("cv.weighted_sum",),
                rubrics=(Rubric(dimension="mathematical", criterion="Computes the sum of pairwise products in the stated order."),),
                verifier=VerifierSpec(kind="weighted_sum", parameters={"values": [2, 4, 1], "weights": [-1, 0, 1]}),
            ),
        ),
    ),
    TopicPack(
        pack_id="linear.transformations.v1", title="Linear transformations",
        concepts=(
            Concept(concept_id="linear.transform", title="Matrix transformation"),
            Concept(concept_id="linear.eigenvector", title="Eigenvectors", prerequisites=("linear.transform",)),
        ),
        tasks=(
            TaskSpec(
                task_id="linear.eigenvalue.v1", pack_id="linear.transformations.v1",
                prompt="A = diag(3, 2) and v = (2, 0). Find the eigenvalue associated with v. Enter just the number.",
                concept_ids=("linear.eigenvector",),
                rubrics=(Rubric(dimension="mathematical", criterion="Finds lambda such that Av=lambda v for the supplied nonzero vector."),),
                verifier=VerifierSpec(kind="eigenvalue", parameters={"matrix": [3, 0, 0, 2], "vector": [2, 0]}),
                sources=("https://www.3blue1brown.com/lessons/eigenvalues/",),
            ),
            TaskSpec(
                task_id="linear.eigenvector.explain.v1", pack_id="linear.transformations.v1",
                prompt="If Av = 3v for a nonzero vector v, is -2v also an eigenvector of A? Explain your reasoning, including whether its eigenvalue changes.",
                concept_ids=("linear.eigenvector",),
                rubrics=(Rubric(dimension="analytical", criterion="Uses linearity: A(-2v)=-2Av=3(-2v). The scaled nonzero vector has the same eigenvalue 3."),),
                sources=("https://www.3blue1brown.com/lessons/eigenvalues/",),
            ),
        ),
    ),
)

TASKS = {task.task_id: task for pack in PACKS for task in pack.tasks}


def public_catalog() -> list[dict]:
    """Do not disclose the reference verifier/rubric as part of the question UI."""
    return [{
        "pack_id": pack.pack_id, "title": pack.title, "version": pack.version,
        "tasks": [{"task_id": task.task_id, "prompt": task.prompt,
                   "concept_ids": list(task.concept_ids)} for task in pack.tasks],
    } for pack in PACKS]
