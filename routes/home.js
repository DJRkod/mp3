module.exports = function (router) {
    router.route('/').get(function (req, res) {
        res.json({ message: 'Llama.io task API. See /api/users and /api/tasks.', data: null });
    });
    return router;
};
